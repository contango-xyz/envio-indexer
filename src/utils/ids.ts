import { AccountingType, GenericEvent } from "../accounting/lotsAccounting";
import { EventType } from "./types";

export const createIdForPosition = ({ chainId, positionId }: Pick<GenericEvent, 'chainId'> & { positionId: string; }): `${number}_${string}` => `${chainId}_${positionId.toLowerCase()}`

export const createEventId = <T extends EventType>(
  { chainId, block: { number: blockNumber }, transaction: { hash: transactionHash }, logIndex, eventType }: GenericEvent & { eventType: T; }
): `${number}_${number}_${string}_${number}_${T}` => `${chainId}_${blockNumber}_${transactionHash.toLowerCase()}_${logIndex}_${eventType}`;

export const createFillItemId = (
  { chainId, block: { number: blockNumber }, positionId }: Pick<GenericEvent, 'chainId' | 'block'> & { positionId: string; }
) => `${chainId}_${blockNumber}_${positionId.toLowerCase()}` as const

export const createIdForLot = (
  { chainId, positionId, index }: { chainId: number; positionId: string; index: number; }
) => `${chainId}_${positionId.toLowerCase()}_${index}` as const;


export const decodeLotId = (id: string) => {
  const [chainId, positionId, lotNumber] = id.split('_');
  return { chainId: parseInt(chainId), positionId, lotNumber: parseInt(lotNumber) };
};

export const createStoreKey = (
  { chainId, block: { number: blockNumber }, transaction: { hash: transactionHash } }: Omit<GenericEvent, 'block' | 'logIndex' | 'params' | 'srcAddress'> & { block: { number: number } }
) => `${chainId}-${blockNumber}-${transactionHash}` as const

export type EventId = ReturnType<typeof createEventId>
export type StoreKey = ReturnType<typeof createStoreKey>

export const decodeEventId = (eventId: EventId): { chainId: number; blockNumber: number; transactionHash: string; logIndex: number; eventType: EventType; } => {
  const [chainId, blockNumber, transactionHash, logIndex, eventType] = eventId.split('_');
  return { chainId: parseInt(chainId), blockNumber: parseInt(blockNumber), transactionHash, logIndex: parseInt(logIndex), eventType: eventType as EventType };
};

export const decodeStoreKey = (storeKey: StoreKey): { chainId: number; blockNumber: number; transactionHash: string; } => {
  const [chainId, blockNumber, transactionHash] = storeKey.split('-');
  return { chainId: parseInt(chainId), blockNumber: parseInt(blockNumber), transactionHash };
};

