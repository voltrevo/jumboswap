import { EventEmitter } from 'ee-typed';
import { IRoom } from './Room';
import { Party } from './Ctx';
import { PublicKey } from './EcdhKeyPair';
import { Key } from 'rtc-pair-socket';
import { z } from 'zod';
import bufferCmp from './bufferCmp';

type Events = {
  partiesUpdated(parties: Party[]): void;
};

const Ping = z.object({
  type: z.literal('ping'),
  pingId: z.number(),
});

const Pong = z.object({
  type: z.literal('pong'),
  pingId: z.number(),
});

export default class PartyTracker extends EventEmitter<Events> {
  partiesById: Record<string, Party> = {};
  memberIds: string[] = [];

  constructor(
    public pk: PublicKey,
    public room: IRoom,
  ) {
    super();

    room.on('membersChanged', members => {
      console.log('membersChanged', members);
      this.setMembers(members);
    });
  }

  setMembers(members: PublicKey[]) {
    this.memberIds = members.map(m => Key.fromSeed(m).base58());

    for (const [i, memberId] of this.memberIds.entries()) {
      if (!(memberId in this.partiesById)) {
        this.partiesById[memberId] = {
          name: '',
          item: '',
          ready: false,
          ping: undefined,
        };

        this.pingLoop(memberId, members[i]);
      }
    }

    for (const key of Object.keys(this.partiesById)) {
      if (!this.memberIds.includes(key)) {
        delete this.partiesById[key];
      }
    }

    this.emitPartiesUpdated();
  }

  getSelf() {
    const selfId = Key.fromSeed(this.pk).base58();
    let self = this.partiesById[selfId];

    if (!self) {
      self = {
        name: '',
        item: '',
        ready: false,
        ping: undefined,
      };

      this.partiesById[selfId] = self;
    }

    return self;
  }

  async pingLoop(memberId: string, otherPk: PublicKey) {
    if (bufferCmp(this.pk.publicKey, otherPk.publicKey) === 0) {
      // Don't ping self
      return;
    }

    let lastPing = 0;
    const socket = await this.room.getSocket(otherPk);

    {
      const recentPingIds: number[] = [];

      socket.on('message', data => {
        const parsed = Ping.safeParse(data);

        if (parsed.data) {
          const { pingId } = parsed.data;

          if (recentPingIds.includes(pingId)) {
            return;
          }

          socket.send({
            type: 'pong',
            pingId,
          });

          recentPingIds.push(pingId);

          while (recentPingIds.length > 10) {
            recentPingIds.shift();
          }
        }
      });
    }

    while (!socket.isClosed()) {
      const pingStart = Date.now();
      const pingId = Math.random();
      let gotReply = false;

      (async () => {
        while (!socket.isClosed()) {
          socket.send({ type: 'ping', pingId });

          await new Promise(resolve => {
            setTimeout(resolve, 1000);
          });

          if (gotReply) {
            break;
          }

          const cumulPing = Date.now() - pingStart;

          if (cumulPing > lastPing) {
            lastPing = cumulPing;
            this.partiesById[memberId].ping = cumulPing;
            this.emitPartiesUpdated();
          }
        }
      })();

      await new Promise<void>((resolve, reject) => {
        socket.on('close', reject);

        function checkPong(msg: unknown) {
          const parsed = Pong.safeParse(msg);

          if (!parsed.data) {
            return;
          }

          if (parsed.data.pingId !== pingId) {
            console.error('Received pong with unexpected pingId');
            return;
          }

          gotReply = true;
          socket.off('message', checkPong);
          socket.off('close', reject);
          resolve();
        }

        socket.on('message', checkPong);
      });

      const pingEnd = Date.now();

      this.partiesById[memberId].ping = pingEnd - pingStart;
      this.emitPartiesUpdated();
      lastPing = pingEnd - pingStart;

      await new Promise(resolve => {
        setTimeout(resolve, 1000);
      });
    }
  }

  emitPartiesUpdated() {
    const parties = this.memberIds.map(mId => this.partiesById[mId]);
    this.emit('partiesUpdated', parties);
  }
}
