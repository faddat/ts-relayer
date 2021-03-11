import { toUtf8 } from '@cosmjs/encoding';
import { Coin, logs, StdFee } from '@cosmjs/launchpad';
import { BroadcastTxFailure } from '@cosmjs/stargate';
import {
  ReadonlyDateWithNanoseconds,
  Header as RpcHeader,
  ValidatorPubkey as RpcPubKey,
} from '@cosmjs/tendermint-rpc';
import Long from 'long';

import { HashOp, LengthOp } from '../codec/confio/proofs';
import { Timestamp } from '../codec/google/protobuf/timestamp';
import { Packet } from '../codec/ibc/core/channel/v1/channel';
import { Height } from '../codec/ibc/core/client/v1/client';
import {
  ClientState as TendermintClientState,
  ConsensusState as TendermintConsensusState,
} from '../codec/ibc/lightclients/tendermint/v1/tendermint';
import { PublicKey as ProtoPubKey } from '../codec/tendermint/crypto/keys';

import { PacketWithMetadata } from './endpoint';

export interface Ack {
  readonly acknowledgement: Uint8Array;
  readonly originalPacket: Packet;
}

export function createBroadcastTxErrorMessage(
  result: BroadcastTxFailure
): string {
  return `Error when broadcasting tx ${result.transactionHash} at height ${result.height}. Code: ${result.code}; Raw log: ${result.rawLog}`;
}

export function toIntHeight(height?: Height): number {
  return height?.revisionHeight?.toNumber() ?? 0;
}

export function ensureIntHeight(height: number | Height): number {
  if (typeof height === 'number') {
    return height;
  }
  return toIntHeight(height);
}

export function subtractBlock(height: Height, count = 1): Height {
  return {
    revisionNumber: height.revisionNumber,
    revisionHeight: height.revisionHeight.subtract(count),
  };
}

const regexRevNum = new RegExp('-([1-9][0-9]*)$');

export function parseRevisionNumber(chainId: string): Long {
  const match = chainId.match(regexRevNum);
  if (match && match.length >= 2) {
    return Long.fromString(match[1]);
  }
  return new Long(0);
}

// may will run the transform if value is defined, otherwise returns undefined
export function may<T, U>(
  transform: (val: T) => U,
  value: T | null | undefined
): U | undefined {
  return value === undefined || value === null ? undefined : transform(value);
}

export function mapRpcPubKeyToProto(
  pubkey?: RpcPubKey
): ProtoPubKey | undefined {
  if (pubkey === undefined) {
    return undefined;
  }
  if (pubkey.algorithm == 'ed25519') {
    return {
      ed25519: pubkey.data,
      secp256k1: undefined,
    };
  } else if (pubkey.algorithm == 'secp256k1') {
    return {
      ed25519: undefined,
      secp256k1: pubkey.data,
    };
  } else {
    throw new Error(`Unknown validator pubkey type: ${pubkey.algorithm}`);
  }
}

export function timestampFromDateNanos(
  date: ReadonlyDateWithNanoseconds
): Timestamp {
  const nanos = (date.getTime() % 1000) * 1000000 + (date.nanoseconds ?? 0);
  return Timestamp.fromPartial({
    seconds: new Long(date.getTime() / 1000),
    nanos,
  });
}

export function secondsFromDateNanos(
  date: ReadonlyDateWithNanoseconds
): number {
  return date.getTime() / 1000;
}

export function buildConsensusState(
  header: RpcHeader
): TendermintConsensusState {
  return TendermintConsensusState.fromPartial({
    timestamp: timestampFromDateNanos(header.time),
    root: {
      hash: header.appHash,
    },
    nextValidatorsHash: header.nextValidatorsHash,
  });
}

// Note: we hardcode a number of assumptions, like trust level, clock drift, and assume revisionNumber is 1
export function buildClientState(
  chainId: string,
  unbondingPeriodSec: number,
  trustPeriodSec: number,
  height: Height
): TendermintClientState {
  // Copied here until https://github.com/confio/ics23/issues/36 is resolved
  // https://github.com/confio/ics23/blob/master/js/src/proofs.ts#L11-L26
  const iavlSpec = {
    leafSpec: {
      prefix: Uint8Array.from([0]),
      hash: HashOp.SHA256,
      prehashValue: HashOp.SHA256,
      prehashKey: HashOp.NO_HASH,
      length: LengthOp.VAR_PROTO,
    },
    innerSpec: {
      childOrder: [0, 1],
      minPrefixLength: 4,
      maxPrefixLength: 12,
      childSize: 33,
      hash: HashOp.SHA256,
    },
  };
  const tendermintSpec = {
    leafSpec: {
      prefix: Uint8Array.from([0]),
      hash: HashOp.SHA256,
      prehashValue: HashOp.SHA256,
      prehashKey: HashOp.NO_HASH,
      length: LengthOp.VAR_PROTO,
    },
    innerSpec: {
      childOrder: [0, 1],
      minPrefixLength: 1,
      maxPrefixLength: 1,
      childSize: 32,
      hash: HashOp.SHA256,
    },
  };

  return TendermintClientState.fromPartial({
    chainId,
    trustLevel: {
      numerator: Long.fromInt(1),
      denominator: Long.fromInt(3),
    },
    unbondingPeriod: {
      seconds: new Long(unbondingPeriodSec),
    },
    trustingPeriod: {
      seconds: new Long(trustPeriodSec),
    },
    maxClockDrift: {
      seconds: new Long(20),
    },
    latestHeight: height,
    proofSpecs: [iavlSpec, tendermintSpec],
    upgradePath: ['upgrade', 'upgradedIBCState'],
    allowUpdateAfterExpiry: false,
    allowUpdateAfterMisbehaviour: false,
  });
}

interface ParsedAttribute {
  readonly key: string;
  readonly value: string;
}

interface ParsedEvent {
  readonly type: string;
  readonly attributes: readonly ParsedAttribute[];
}

export function parsePacketsFromLogs(logs: readonly logs.Log[]): Packet[] {
  // grab all send_packet events from the logs
  const allEvents: ParsedEvent[][] = logs.map((log) =>
    log.events.filter(({ type }) => type === 'send_packet')
  );
  const flatEvents = ([] as ParsedEvent[]).concat(...allEvents);
  return flatEvents.map(parsePacket);
}

export function parsePacket({ type, attributes }: ParsedEvent): Packet {
  if (type !== 'send_packet') {
    throw new Error(`Cannot parse event of type ${type}`);
  }
  const attributesObj: Record<string, string> = attributes.reduce(
    (acc, { key, value }) => ({
      ...acc,
      [key]: value,
    }),
    {}
  );

  console.log(
    `Parse timeouts: ${attributesObj.packet_timeout_height} / ${attributesObj.packet_timeout_timestamp}`
  );
  const [timeoutRevisionNumber, timeoutRevisionHeight] =
    attributesObj.packet_timeout_height?.split('-') ?? [];
  return Packet.fromPartial({
    sequence: may(Long.fromString, attributesObj.packet_sequence),
    /** identifies the port on the sending chain. */
    sourcePort: attributesObj.packet_src_port,
    /** identifies the channel end on the sending chain. */
    sourceChannel: attributesObj.packet_src_channel,
    /** identifies the port on the receiving chain. */
    destinationPort: attributesObj.packet_dst_port,
    /** identifies the channel end on the receiving chain. */
    destinationChannel: attributesObj.packet_dst_channel,
    /** actual opaque bytes transferred directly to the application module */
    data: attributesObj.packet_data
      ? toUtf8(attributesObj.packet_data)
      : undefined,
    /** block height after which the packet times out */
    timeoutHeight:
      timeoutRevisionNumber && timeoutRevisionHeight
        ? Height.fromPartial({
            revisionNumber: Long.fromString(timeoutRevisionNumber),
            revisionHeight: Long.fromString(timeoutRevisionHeight),
          })
        : undefined,
    /** block timestamp (in nanoseconds) after which the packet times out */
    timeoutTimestamp: may(
      Long.fromString,
      attributesObj.packet_timeout_timestamp
    ),
  });
}

export function parseAcksFromLogs(logs: readonly logs.Log[]): Ack[] {
  // grab all send_packet events from the logs
  const allEvents: ParsedEvent[][] = logs.map((log) =>
    log.events.filter(({ type }) => type === 'write_acknowledgement')
  );
  const flatEvents = ([] as ParsedEvent[]).concat(...allEvents);
  return flatEvents.map(parseAck);
}

export function parseAck({ type, attributes }: ParsedEvent): Ack {
  if (type !== 'write_acknowledgement') {
    throw new Error(`Cannot parse event of type ${type}`);
  }
  const attributesObj: Record<string, string | undefined> = attributes.reduce(
    (acc, { key, value }) => ({
      ...acc,
      [key]: value,
    }),
    {}
  );
  const [timeoutRevisionNumber, timeoutRevisionHeight] =
    attributesObj.packet_timeout_height?.split('-') ?? [];
  const originalPacket = Packet.fromPartial({
    sequence: may(Long.fromString, attributesObj.packet_sequence),
    /** identifies the port on the sending chain. */
    sourcePort: attributesObj.packet_src_port,
    /** identifies the channel end on the sending chain. */
    sourceChannel: attributesObj.packet_src_channel,
    /** identifies the port on the receiving chain. */
    destinationPort: attributesObj.packet_dst_port,
    /** identifies the channel end on the receiving chain. */
    destinationChannel: attributesObj.packet_dst_channel,
    /** actual opaque bytes transferred directly to the application module */
    data: toUtf8(attributesObj.packet_data ?? ''),
    /** block height after which the packet times out */
    timeoutHeight:
      timeoutRevisionNumber && timeoutRevisionHeight
        ? Height.fromPartial({
            revisionNumber: Long.fromString(timeoutRevisionNumber),
            revisionHeight: Long.fromString(timeoutRevisionHeight),
          })
        : undefined,
    /** block timestamp (in nanoseconds) after which the packet times out */
    timeoutTimestamp: may(
      Long.fromString,
      attributesObj.packet_timeout_timestamp
    ),
  });
  const acknowledgement = toUtf8(attributesObj.packet_ack ?? '');
  return {
    acknowledgement,
    originalPacket,
  };
}

export function multiplyFees({ gas, amount }: StdFee, mult: number): StdFee {
  const multGas = Number.parseInt(gas, 10) * mult;
  const multAmount = amount.map(multiplyCoin, mult);
  return {
    gas: multGas.toString(),
    amount: multAmount,
  };
}

export function multiplyCoin({ amount, denom }: Coin, mult: number): Coin {
  const multAmount = Number.parseInt(amount, 10) * mult;
  return { amount: multAmount.toString(), denom };
}

// return true if a > b, or a undefined
function heightGreater(a: Height | undefined, b: Height): boolean {
  if (a === undefined) {
    return true;
  }
  let valid = a.revisionNumber > b.revisionNumber;
  if (a.revisionNumber.toNumber() === b.revisionNumber.toNumber()) {
    valid = a.revisionHeight > b.revisionHeight;
  }
  return valid;
}

// return true if a > b, or a 0
// note a is nanoseconds, while b is seconds
function timeGreater(a: Long | undefined, b: number): boolean {
  if (a === undefined || a.isZero()) {
    console.log('time undefined!');
    return true;
  }
  return a.toNumber() > b * 1_000_000_000;
}

// take height and time from receiving chain to see which packets have timed out
// return [toSubmit, toTimeout].
// you can advance height, time a block or two into the future if you wish a margin of error
export function splitPendingPackets(
  currentHeight: Height,
  currentTime: number, // in seconds
  packets: readonly PacketWithMetadata[]
): {
  readonly toSubmit: readonly PacketWithMetadata[];
  readonly toTimeout: readonly PacketWithMetadata[];
} {
  return packets.reduce(
    (acc, packet) => {
      const validPacket =
        heightGreater(packet.packet.timeoutHeight, currentHeight) &&
        timeGreater(packet.packet.timeoutTimestamp, currentTime);
      return validPacket
        ? {
            ...acc,
            toSubmit: [...acc.toSubmit, packet],
          }
        : {
            ...acc,
            toTimeout: [...acc.toTimeout, packet],
          };
    },
    {
      toSubmit: [] as readonly PacketWithMetadata[],
      toTimeout: [] as readonly PacketWithMetadata[],
    }
  );
}
