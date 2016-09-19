import {
  SIGNALING,
  BOT,
  INSTANCES,
  MSG_NUMBER,
  LEAVE_CODE,
  randData,
  sendReceive
} from 'utils/helper'
import smallStr from 'utils/200kb.txt'
import bigStr from 'utils/4mb.txt'
import WebChannel from 'src/WebChannel'

describe('🙂 🤖  fully connected', () => {
  let signaling = SIGNALING
  let wc

  it('Should establish a connection through socket', done => {
    wc = new WebChannel({signaling})
    wc.onJoining = id => expect(id).toEqual(wc.members[0])
    spyOn(wc, 'onJoining')
    wc.addBotServer(BOT)
      .then(id => {
        expect(wc.members.length).toEqual(1)
        expect(wc.onJoining).toHaveBeenCalledTimes(1)
        done()
      })
      .catch(done.fail)
  })

  describe('Should send/receive', () => {

    it('Private string message', done => {
      let data = randData(String)
      sendReceive(wc, data, done, wc.members[0])
    })

    for (let i of INSTANCES) {
      it('broadcast: ' + i.prototype.constructor.name, done => {
        let data = randData(i)
        sendReceive(wc, data, done)
      })
    }

    it('broadcast: ~200 KB string', done => {
      sendReceive(wc, smallStr, done)
    })

    xit('broadcast: ~4 MB string', done => {
      sendReceive(wc, bigStr, done)
    }, 10000)

    it(`${MSG_NUMBER} small messages`, done => {
      let data = []
      let dataReceived = Array(MSG_NUMBER)
      for (let i = 0; i < MSG_NUMBER; i++) data[i] = randData(String)
      dataReceived.fill(0)
      wc.onMessage = (id, msg, isBroadcast) => {
        expect(typeof msg).toEqual('string')
        let index = data.indexOf(msg)
        expect(index).not.toEqual(-1)
        expect(dataReceived[index]++).toEqual(0)
        expect(isBroadcast).toBeTruthy()
        done()
      }
      for (let d of data) wc.send(d)
    }, 10000)
  })

  it('Should ping', done => {
    wc.ping().then(p => expect(Number.isInteger(p)).toBeTruthy()).then(done).catch(done.fail)
  })

  describe('Should leave', () => {
    const message = 'Hi world!'

    it('🙂', done => {
      wc.onMessage = done.fail
      wc.leave()
      expect(wc.members.length).toEqual(0)
      wc.send(message)
      setTimeout(done, 100)
    })

    it('🤖', done => {
      wc.onMessage = done.fail
      wc.onLeaving = id => {
        expect(wc.members.length).toEqual(0)
        wc.send(message)
        setTimeout(done, 100)
      }
      wc.addBotServer(BOT)
        .then(() => {
          wc.sendTo(wc.members[0], JSON.stringify({code: LEAVE_CODE}))
        })
        .catch(done.fail)
    })
  })
})