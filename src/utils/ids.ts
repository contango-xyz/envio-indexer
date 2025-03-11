import { Hex } from "viem";
import { AccountingType, GenericEvent } from "../accounting/lotsAccounting";
import { ContangoEvents, EventType } from "./types";

export const createIdForPosition = ({ chainId, contangoPositionId }: Pick<GenericEvent, 'chainId'> & { contangoPositionId: string; }): `${number}_${string}` => `${chainId}_${contangoPositionId.toLowerCase()}`

// important: this is not the same as `positionId` that we're used to. This is the ID of the entity in the database, and includes the chainId
export type IdForPosition = ReturnType<typeof createIdForPosition>

export const decodeIdForPosition = (id: IdForPosition) => {
  const [chainId, positionId] = id.split('_')
  return { chainId: parseInt(chainId), positionId: positionId as Hex }
}

export const createEventId = <T extends EventType>(
  { chainId, block: { number: blockNumber }, transaction: { hash: transactionHash }, logIndex, eventType }: GenericEvent & { eventType: T; }
): `${number}_${number}_${string}_${number}_${T}` => `${chainId}_${blockNumber}_${transactionHash.toLowerCase()}_${logIndex}_${eventType}`;

export const createFillItemId = (
  { chainId, blockNumber, positionId }: ContangoEvents & { positionId: string; }
) => `${chainId}_${blockNumber}_${positionId.toLowerCase()}` as const

export const createIdForLot = (
  { chainId, positionId, index }: { chainId: number; positionId: string; index: number; }
) => `${chainId}_${positionId.toLowerCase()}_${index}` as const;


export const decodeLotId = (id: string) => {
  const [chainId, positionId, lotNumber] = id.split('_');
  return { chainId: parseInt(chainId), positionId, lotNumber: parseInt(lotNumber) };
};

export const createStoreKey = ({ chainId, blockNumber, transactionHash }: Pick<ContangoEvents, 'chainId' | 'blockNumber' | 'transactionHash'>) => `${chainId}-${blockNumber}-${transactionHash}` as const
export type StoreKey = ReturnType<typeof createStoreKey>

export const createStoreKeyFromEvent = (event: GenericEvent) => createStoreKey({ chainId: event.chainId, blockNumber: event.block.number, transactionHash: event.transaction.hash })

export type EventId = ReturnType<typeof createEventId>

export const decodeEventId = (eventId: EventId): { chainId: number; blockNumber: number; transactionHash: string; logIndex: number; eventType: EventType; } => {
  const [chainId, blockNumber, transactionHash, logIndex, eventType] = eventId.split('_');
  return { chainId: parseInt(chainId), blockNumber: parseInt(blockNumber), transactionHash, logIndex: parseInt(logIndex), eventType: eventType as EventType };
};

export const decodeStoreKey = (storeKey: StoreKey): { chainId: number; blockNumber: number; transactionHash: string; } => {
  const [chainId, blockNumber, transactionHash] = storeKey.split('-');
  return { chainId: parseInt(chainId), blockNumber: parseInt(blockNumber), transactionHash };
};

