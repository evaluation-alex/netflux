import 'rxjs/add/operator/map'
import { Subscription } from 'rxjs/Subscription'

import { TopologyInterface } from './TopologyInterface'
import { fullMesh } from '../../Protobuf'
import { WebChannel } from '../WebChannel'
import { Channel } from '../../Channel'
import { Service } from '../Service'
import { MessageI, ServiceMessageDecoded } from '../../Util'

/**
 * {@link FullMesh} identifier.
 * @ignore
 * @type {number}
 */
export const FULL_MESH = 3

/**
 * Fully connected web channel manager. Implements fully connected topology
 * network, when each peer is connected to each other.
 *
 * @extends module:webChannelManager~WebChannelTopologyInterface
 */
export class FullMesh extends Service implements TopologyInterface {

  private wc: WebChannel
  private channels: Set<Channel>
  private jps: Map<number, Channel>
  private channelsSubs: Subscription

  constructor (wc) {
    super(FULL_MESH, fullMesh.Message, wc._svcMsgStream)
    this.wc = wc
    this.init()
  }

  private init (): void {
    this.channels = new Set()
    this.jps = new Map()
    this.svcMsgStream.subscribe(
      msg => this.handleSvcMsg(msg),
      err => console.error('FullMesh Message Stream Error', err),
      () => this.leave()
    )
    this.channelsSubs = this.wc.channelBuilder.channels().subscribe(
      ch => this.peerJoined(ch),
      err => console.error('FullMesh set joining peer Error', err)
    )
  }

  clean () {}

  addJoining (ch: Channel): void {
    console.info(this.wc.myId + ' addJoining ' + ch.peerId)
    const peers = this.wc.members.slice()
    this.peerJoined(ch)

    // First joining peer
    if (peers.length === 0) {
      ch.send(this.wc._encode({
        recipientId: ch.peerId,
        content: super.encode({ joinSucceed: true })
      }))

    // There are at least 2 members in the network
    } else {
      this.jps.set(ch.peerId, ch)
      this.wc._send({ content: super.encode({ joiningPeerId: ch.peerId }) })
      ch.send(this.wc._encode({
        recipientId: ch.peerId,
        content: super.encode({ connectTo: { peers } })
      }))
    }
  }

  initJoining (ch: Channel): void {
    console.info(this.wc.myId + ' initJoining ' + ch.peerId)
    this.jps.set(this.wc.myId, ch)
    this.peerJoined(ch)
  }

  send (msg: MessageI): void {
    const bytes = this.wc._encode(msg)
    for (let ch of this.channels) {
      ch.send(bytes)
    }
  }

  forward (msg: MessageI): void { /* Nothing to do for this topology */ }

  sendTo (msg: MessageI): void {
    const bytes = this.wc._encode(msg)
    for (let ch of this.channels) {
      if (ch.peerId === msg.recipientId) {
        return ch.send(bytes)
      }
    }
    for (let [id, ch] of this.jps) {
      if (id === msg.recipientId || id === this.wc.myId) {
        return ch.send((bytes))
      }
    }
    return console.error(this.wc.myId + ' The recipient could not be found', msg.recipientId)
  }

  forwardTo (msg: MessageI): void { this.sendTo(msg) }

  leave (): void {
    for (let ch of this.channels) {
      ch.close()
    }
    for (let ch of this.jps.values()) {
      ch.close()
    }
    this.channels.clear()
    this.jps.clear()
    this.channelsSubs.unsubscribe()
  }

  onChannelClose (closeEvt: CloseEvent, channel: Channel): void {
    if (this.wc.state === WebChannel.JOINING) {
      const firstChannel = this.channels.values().next().value
      if (firstChannel.peerId === channel.peerId) {
        this.wc._joinFailed(this.wc.myId + ' intermediary peer has gone: ' + closeEvt.reason)
        this.leave()
      } else {
        this.channels.delete(channel)
        console.info(this.wc.myId + ' _onPeerLeave while I am joining ' + channel.peerId)
        this.wc._onPeerLeave(channel.peerId)
      }
    } else {
      for (let [id] of this.jps) {
        if (id === channel.peerId) {
          this.jps.delete(id)
          return
        }
      }
      if (this.channels.has(channel)) {
        this.channels.delete(channel)
        console.info(this.wc.myId + ' _onPeerLeave ' + channel.peerId)
        this.wc._onPeerLeave(channel.peerId)
      }
    }
  }

  onChannelError (evt: Event, channel: Channel): void {
    console.error(`Channel error with id: ${channel.peerId}: `, evt)
  }

  private handleSvcMsg ({channel, senderId, recipientId, msg}: ServiceMessageDecoded): void {
    switch (msg.type) {
    case 'connectTo': {
      const peers = msg.connectTo.peers
      let counter = 0
      const connected = []
      const allCompleted = new Promise(resolve => {
        for (let ch of this.channels) {
          const index = peers.indexOf(ch.peerId)
          if (index !== -1) {
            peers.splice(index, 1)
          }
          connected[connected.length] = ch.peerId
        }
        for (let id of peers) {
          this.wc.channelBuilder.connectTo(id)
            .then(ch => {
              this.peerJoined(ch)
              connected[connected.length] = id
              if (++counter === peers.length) {
                resolve()
              }
            })
            .catch(err => {
              console.warn(this.wc.myId + ' failed to connect to ' + id, err.message)
              if (++counter === peers.length) {
                resolve()
              }
            })
        }
      })
      allCompleted.then(() => {
        channel.send(this.wc._encode({
          recipientId: channel.peerId,
          content: super.encode({ connectedTo: { peers: connected } })
        }))
      })
      break
    }
    case 'connectedTo': {
      const peers = msg.connectedTo.peers
      const missingPeers = []
      for (let id of this.wc.members) {
        if (!peers.includes(id) && id !== channel.peerId) {
          missingPeers[missingPeers.length] = id
        }
      }
      if (missingPeers.length === 0) {
        channel.send(this.wc._encode({
          recipientId: channel.peerId,
          content: super.encode({ joinSucceed: true })
        }))
      } else {
        channel.send(this.wc._encode({
          recipientId: channel.peerId,
          content: super.encode({ connectTo: { peers: missingPeers } })
        }))
      }
      break
    }
    case 'joiningPeerId': {
      this.jps.set(msg.joiningPeerId, channel)
      break
    }
    case 'joinSucceed': {
      this.jps.delete(this.wc.myId)
      this.wc._joinSucceed()
      console.info(this.wc.myId + ' _joinSucceed ')
      break
    }
    case 'joinFailedPeerId': {
      this.jps.delete(this.wc.myId)
      console.info(this.wc.myId + ' joinFailed ' + msg.joinFailedPeerId)
      break
    }
    }
  }

  private peerJoined (ch: Channel): void {
    this.channels.add(ch)
    this.jps.delete(ch.peerId)
    this.wc._onPeerJoin(ch.peerId)
    console.info(this.wc.myId + ' _onPeerJoin ' + ch.peerId)
  }

  onChannelMessage (channel: Channel, bytes: Uint8Array): void {
    if (this.wc.state === WebChannel.DISCONNECTED) {
      return
    }

    const msg = <MessageI> this.wc._decode(bytes)

    console.warn(this.wc.myId + ` new message from ${channel.peerId} : ${msg.senderId} => ${msg.recipientId}`, msg)
    switch (msg.recipientId) {
    // If the message is broadcasted
    case 0:
      this.wc._treatMessage(channel, msg)
      this.forward(msg)
      break

    // If it is a private message to me
    case this.wc.myId:
      this.wc._treatMessage(channel, msg)
      break

    // If is is a message to me from a peer who does not know yet my ID
    case 1:
      this.wc._treatMessage(channel, msg)
      break

    // Otherwise the message should be forwarded to the intended peer
    default:
      this.forwardTo(msg)
    }
  }
}
