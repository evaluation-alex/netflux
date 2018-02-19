import { Observable } from 'rxjs/Observable'
import { Subject } from 'rxjs/Subject'
import { Subscription } from 'rxjs/Subscription'

import { Channel } from '../../Channel'
import { log } from '../../misc/Util'
import { fullMesh, IMessage } from '../../proto'
import { IServiceMessageDecoded, Service } from '../Service'
import { WebChannel, WebChannelState } from '../WebChannel'
import { ITopology, TopologyStateEnum } from './Topology'

/**
 * {@link FullMesh} identifier.
 * @ignore
 * @type {number}
 */
export const FULL_MESH = 3

interface IDistantPeer {
  adjacentIds: Set<number>,
  missedHeartbeat: number
}

const REQUEST_MEMBERS_INTERVAL = 15000

const MAX_ROUTE_DISTANCE = 3

const HEARTBEAT_INTERVAL = 3000
const MAXIMUM_MISSED_HEARTBEAT = 3
const HEARTBEAT_MESSAGE = Service.encodeServiceMessage(FULL_MESH,
  fullMesh.Message.encode(fullMesh.Message.create({ heartbeat: true })).finish())

/**
 * Fully connected web channel manager. Implements fully connected topology
 * network, when each peer is connected to each other.
 *
 */
export class FullMesh extends Service implements ITopology {

  private wc: WebChannel

  /**
   * Directly connected peers.
   */
  private adjacentMembers: Map<number, Channel>

  /**
   * Peers that are not adjacent. When the connection with a distant peer is established,
   * his id is removed from this map a new entry is added to the `adjacentMembers` property.
   */
  private distantMembers: Map<number, IDistantPeer>

  /**
   * Set of peers among `distantMembers` to whom you are connecting right now.
   */
  private connectingMembers: Set<number>

  private stateSubject: Subject<TopologyStateEnum>

  private heartbeatInterval: any
  private membersRequestInterval: any

  constructor (wc) {
    super(FULL_MESH, fullMesh.Message, wc.serviceMessageSubject)
    this.wc = wc
    this.adjacentMembers = new Map()
    this.distantMembers = new Map()
    this.connectingMembers = new Set()
    this.stateSubject = new Subject()
    this.onServiceMessage.subscribe((msg) => this.handleSvcMsg(msg))
    this.wc.channelBuilder.onChannel.subscribe((ch) => this.addAdjacentMember(ch))
  }

  get onState (): Observable<TopologyStateEnum> {
    return this.stateSubject.asObservable()
  }

  clean () {
    this.distantMembers.clear()
    // TODO: clear properly connectingMembers
    clearInterval(this.heartbeatInterval)
    this.heartbeatInterval = undefined
    clearInterval(this.membersRequestInterval)
    this.membersRequestInterval = undefined
  }

  addJoining (ch: Channel): void {
    // FIXME: test if `ch` already exists among `adjacentMembers`
    this.addAdjacentMember(ch)
  }

  initJoining (ch: Channel, ids: number[]): void {
    // FIXME: test if `ch` already exists among `adjacentMembers`
    this.addAdjacentMember(ch)
    this.connectToMany(ids, ch.id)
      .then(() => {
        this.stateSubject.next(TopologyStateEnum.JOINED)
        this.stateSubject.next(TopologyStateEnum.STABLE)
      })
      .then(() => this.membersRequest())
  }

  send (msg: IMessage): void {
    this.adjacentMembers.forEach((ch) => ch.send(this.wc.encode(msg)))
    this.distantMembers.forEach((distantPeer, id) => {
      this.sendToDistantPeer(distantPeer, { recipientId: id, isService: msg.isService, content: msg.content })
    })
  }

  forward (msg: IMessage): void {
    if (msg.recipientId > 1) {
      this.sendTo(msg)
    }
  }

  sendTo (msg: IMessage): void {
    const ch = this.adjacentMembers.get(msg.recipientId)
    if (ch) {
      ch.send(this.wc.encode(msg))
    } else {
      this.sendToDistantPeer(this.distantMembers.get(msg.recipientId), msg)
    }
  }

  leave (): void {
    this.adjacentMembers.forEach((ch) => ch.close())
    this.clean()
  }

  onChannelClose (event: Event, channel: Channel): void {
    if (this.adjacentMembers.delete(channel.id)) {
      this.wc.onMemberLeaveProxy(channel.id)
      if (this.adjacentMembers.size === 0) {
        this.clean()
      } else {
        this.notifyDistantPeers()
      }
    }
  }

  onChannelError (evt: Event, channel: Channel): void {
    console.warn(`Channel error: ${evt.type}`)
  }

  private handleSvcMsg ({channel, senderId, recipientId, msg}: IServiceMessageDecoded): void {
    switch (msg.type) {
    case 'membersResponse': {
      this.connectToMany(msg.membersResponse.ids, senderId)
      break
    }
    case 'membersRequest': {
      channel.send(this.wc.encode({
        recipientId: channel.id,
        content: super.encode({ membersResponse: { ids: this.wc.members } }),
      }))
      break
    }
    case 'adjacentMembers': {
      if (!this.adjacentMembers.has(senderId) && senderId !== this.wc.myId) {
        const distantPeer = this.distantMembers.get(senderId)

        // If it the first time you have met this ID, then send him your neighbours' ids.
        // Otherwise just update the list of distant peer's neighbours
        if (distantPeer) {
          msg.adjacentMembers.ids.forEach((id) => distantPeer.adjacentIds.add(id))
        } else {
          this.distantMembers.set(senderId, { adjacentIds: new Set(msg.adjacentMembers.ids), missedHeartbeat: 0 })
          const adjacentMembers = super.encode({ adjacentMembers: { ids: Array.from(this.adjacentMembers.keys()) } })
          this.wc.sendToProxy({ recipientId: senderId, content: adjacentMembers})
          if (senderId < this.wc.myId) {
            this.connectTo(senderId)
          }
        }
      }
      break
    }
    case 'heartbeat': {
      const distantPeer = this.distantMembers.get(senderId)
      if (distantPeer) {
        log.info('Received HEARTBEAT for a distant peer: ' + senderId)
        distantPeer.missedHeartbeat = 0
      } else if (channel.id === senderId) {
        channel.missedHeartbeat = 0
      }
      break
    }
    }
  }

  private addAdjacentMember (ch: Channel): void {
    console.assert(!this.adjacentMembers.has(ch.id), 'Replicated connection between two peers')
    this.distantMembers.delete(ch.id)
    ch.updateHeartbeatMsg(HEARTBEAT_MESSAGE)
    this.adjacentMembers.set(ch.id, ch)
    if (this.adjacentMembers.size === 1) {
      this.startIntervals()
    }
    this.wc.onMemberJoinProxy(ch.id)
    this.notifyDistantPeers()
  }

  private startIntervals () {
    this.clean()
    this.membersRequestInterval = setInterval(() => this.membersRequest(), REQUEST_MEMBERS_INTERVAL)
    this.heartbeatInterval = global.setInterval(() => {
      this.adjacentMembers.forEach((ch) => {
        try {
          ch.missedHeartbeat++
          if (ch.missedHeartbeat >= MAXIMUM_MISSED_HEARTBEAT) {
            throw new Error('Too many missed heartbeats')
          }
          ch.sendHeartbeat()
        } catch (err) {
          log.info(`Closing connection with ${ch.id}. Reason: ${err.message}`)
          ch.close()
        }
      })
      this.distantMembers.forEach((peer, id) => {
        try {
          peer.missedHeartbeat++
          if (peer.missedHeartbeat >= MAXIMUM_MISSED_HEARTBEAT) {
            throw new Error('Too many missed heartbeats')
          }
          this.wc.sendToProxy({ recipientId: id, content: HEARTBEAT_MESSAGE })
        } catch (err) {
          log.info(`Distant peer ${id} has left. Reason: ${err.message}`)
          this.distantMembers.delete(id)
          this.wc.onMemberLeaveProxy(id)
        }
      })
    }, HEARTBEAT_INTERVAL)
  }

  private connectToMany (ids: number[], adjacentId: number): Promise<void|void[]> {
    const missingIds = ids.filter((id) => {
      return !this.adjacentMembers.has(id) && !this.connectingMembers.has(id) && id !== this.wc.myId
    })
    if (missingIds.length !== 0) {
      const adjacentMembers = super.encode({ adjacentMembers: { ids: Array.from(this.adjacentMembers.keys()) } })
      const connectingAttempts = []

      missingIds.forEach((id) => {
        const distantPeer = this.distantMembers.get(id)
        if (distantPeer) {
          distantPeer.adjacentIds.add(adjacentId)
        } else {
          this.distantMembers.set(id, { adjacentIds: new Set([adjacentId]), missedHeartbeat: 0 })
        }

        // It's important to notify all peers about my adjacentIds first
        // for some specific case such when you should connect to a peer with
        // distance more than 1
        this.wc.sendToProxy({ recipientId: id, content: adjacentMembers})

        // Connect only to the peers whose ids are less than my id. Thus it avoids a
        // problematic situation when both peers are trying to connect to each other
        // at the same time.
        if (id < this.wc.myId) {
          connectingAttempts[connectingAttempts.length] = this.connectTo(id)
        }
      })

      return Promise.all(connectingAttempts)
    }
    return Promise.resolve()
  }

  private connectTo (id: number): Promise<void> {
    this.connectingMembers.add(id)
    return this.wc.channelBuilder.connectTo(id)
      .then((ch: Channel) => {
        this.addAdjacentMember(ch)
        this.connectingMembers.delete(id)
      })
      .catch((err: Error) => {
        if (err.message !== 'pingpong') {
          this.wc.onMemberJoinProxy(id)
        }
        log.info(`${this.wc.myId} failed to connect to ${id}: ${err.message}`)
        this.connectingMembers.delete(id)
      })
  }

  private membersRequest () {
    if (this.adjacentMembers.size !== 0) {
      // Randomly choose a group member to send him a request for his member list
      const index = Math.floor(Math.random() * this.adjacentMembers.size)
      const iterator = this.adjacentMembers.values()
      for (let i = 0; i < index; i++) {
        iterator.next()
      }
      const channel = iterator.next().value
      channel.send(this.wc.encode({
        recipientId: channel.id,
        content: super.encode({ membersRequest: true }),
      }))
    }
  }

  private sendToDistantPeer (distantPeer: IDistantPeer, msg: IMessage) {
    // NO LUCK: recepient is not directly connected to me, thus check distant peers
    // First those who are at distance 1, then 2 etc. up to MAX_ROUTE_DISTANCE
    // (Peer X has a distance equals to 1 if I am not directly connected to X and
    // there is a peer Y which is directly connected to X and to me)
    for (let d = 1; d <= MAX_ROUTE_DISTANCE; d++) {
      const ch = this.findRoutedChannel(distantPeer, d)
      if (ch) {
        ch.send(this.wc.encode(msg))
        return
      }
    }
    console.warn(`${this.wc.myId}: the recipient ${msg.recipientId} could not be found`)
  }

  private findRoutedChannel (distantPeer: IDistantPeer, distance: number): Channel {
    if (distantPeer) {
      for (const [neighbourId, ch] of this.adjacentMembers) {
        if (distantPeer.adjacentIds.has(neighbourId)) {
          return ch
        }
      }
      if (distance !== 0) {
        for (const id of distantPeer.adjacentIds) {
          const ch = this.findRoutedChannel(this.distantMembers.get(id), distance - 1)
          if (ch) {
            return ch
          }
        }
      }
      return undefined
    }
    return undefined
  }

  private notifyDistantPeers () {
    this.distantMembers.forEach((peer, id) => this.wc.sendToProxy({
      recipientId: id,
      content: super.encode({ adjacentMembers: { ids: Array.from(this.adjacentMembers.keys()) } }),
    }))
  }
}
