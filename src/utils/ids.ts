import { AccountingType, GenericEvent } from "../accounting/lotsAccounting";
import { EventType } from "./types";

export const createIdForPosition = ({ chainId, positionId }: Pick<GenericEvent, 'chainId'> & { positionId: string; }): `${number}_${string}` => `${chainId}_${positionId.toLowerCase()}`

export const createEventId = <T extends EventType>(
  { chainId, blockNumber, transactionHash, logIndex, eventType }: Pick<GenericEvent, 'chainId' | 'blockNumber' | 'transactionHash' | 'logIndex'> & { eventType: T; }
): `${number}_${number}_${string}_${number}_${T}` => `${chainId}_${blockNumber}_${transactionHash.toLowerCase()}_${logIndex}_${eventType}`;

export const createFillItemId = (
  { chainId, blockNumber, positionId }: Pick<GenericEvent, 'chainId' | 'blockNumber'> & { positionId: string; }
) => `${chainId}_${blockNumber}_${positionId.toLowerCase()}` as const

export const createIdForLot = (
  { chainId, positionId, blockNumber, accountingType }: Pick<GenericEvent, 'chainId' | 'blockNumber'> & { accountingType: AccountingType; positionId: string; }
) => `${chainId}_${positionId.toLowerCase()}_${blockNumber}_${accountingType}` as const;


export const decodeLotId = (id: string) => {
  const [chainId, positionId, lotNumber] = id.split('_');
  return { chainId: parseInt(chainId), positionId, lotNumber: parseInt(lotNumber) };
};

type _EventIdParams = Omit<Parameters<typeof createEventId>[0], 'eventType'>

export const createLiquidationId = (params: _EventIdParams) => createEventId({ ...params, eventType: EventType.LIQUIDATION });

export const createStoreKey = (
  { chainId, blockNumber, transactionHash }: Pick<GenericEvent, 'chainId' | 'blockNumber' | 'transactionHash'>
) => `${chainId}-${blockNumber}-${transactionHash}` as const


export type EventId = ReturnType<typeof createEventId>
export type StoreKey = ReturnType<typeof createStoreKey>

export const eventIdToStoreKey = (eventId: EventId): StoreKey => {
  const [chainId, blockNumber, transactionHash] = eventId.split('_');
  return createStoreKey({ chainId: parseInt(chainId), blockNumber: parseInt(blockNumber), transactionHash });
};

export const decodeEventId = (eventId: EventId): { chainId: number; blockNumber: number; transactionHash: string; logIndex: number; eventType: EventType; } => {
  const [chainId, blockNumber, transactionHash, logIndex, eventType] = eventId.split('_');
  return { chainId: parseInt(chainId), blockNumber: parseInt(blockNumber), transactionHash, logIndex: parseInt(logIndex), eventType: eventType as EventType };
};

export const decodeStoreKey = (storeKey: StoreKey): { chainId: number; blockNumber: number; transactionHash: string; } => {
  const [chainId, blockNumber, transactionHash] = storeKey.split('-');
  return { chainId: parseInt(chainId), blockNumber: parseInt(blockNumber), transactionHash };
};

