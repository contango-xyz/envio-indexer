import {
  ContangoInstrumentCreatedEvent,
  ContangoPositionUpsertedEvent,
  ContangoProxy,
  Instrument,
  PositionNFT,
  UnderlyingPositionFactory,
  UnderlyingPositionFactory_UnderlyingPositionCreated
} from "generated";
import { Hex, toHex, zeroAddress } from "viem";
import { eventStore } from "./Store";
import { getOrCreateInstrument, getPosition, getPositionSafe, setPosition } from "./utils/common";
import { getOrCreateToken } from "./utils/getTokenDetails";
import { createEventId, createIdForLot, createIdForPosition } from "./utils/ids";
import { strategyContractsAddresses } from "./utils/previousContractAddresses";
import { EventType } from "./utils/types";
import { AccountingType, loadLots } from "./accounting/lotsAccounting";
import { eventsReducer } from "./accounting/processEvents";

ContangoProxy.PositionUpserted.handler(async ({ event, context}) => {
  const eventId = createEventId({ eventType: EventType.POSITION_UPSERTED, chainId: event.chainId, blockNumber: event.block.number, transactionHash: event.transaction.hash, logIndex: event.logIndex })
  const upsertedEvent: ContangoPositionUpsertedEvent = {
    ...event.params,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    chainId: event.chainId,
    id: eventId,
    transactionHash: event.transaction.hash,
  }

  eventStore.addLog({ eventId, contangoEvent: { ...upsertedEvent, eventType: EventType.POSITION_UPSERTED } })

  await eventsReducer(
    {
      chainId: event.chainId,
      blockNumber: event.block.number,
      transactionHash: event.transaction.hash,
      blockTimestamp: event.block.timestamp,
      positionId: event.params.positionId,
      logIndex: event.logIndex,
    },
    context
  )
})

// On create, the NFT transfer event is emitted before the UnderlyingPositionCreated event
PositionNFT.Transfer.handler(async ({ event, context }) => {
  const { block: { number: blockNumber }, transaction: { hash: transactionHash } } = event
  const positionId = toHex(event.params.tokenId, { size: 32 }).toLowerCase() as Hex

  const position = await getPositionSafe({ chainId: event.chainId, positionId, context })
  const to = event.params.to.toLowerCase() as Hex

  if (position) {

    const isTransferToStrategyBuilder = strategyContractsAddresses(event.chainId).has(to)
    // if the transfer is to the strategy builder, we don't update the owner.
    // This is important because when we evaluate cashflows, we need to know the cashflows of the actual owner and not the "temporary" owner
    const owner = isTransferToStrategyBuilder ? position.owner : to
    const isOpen = event.params.to !== zeroAddress // update isOpen when NFT is transferred to the zero address

    let { longLots, shortLots } = await loadLots({ position, context })
    if (owner !== position.owner) {
      longLots = longLots.map(lot => ({ ...lot, owner }))
      shortLots = shortLots.map(lot => ({ ...lot, owner }))
    }

    setPosition({ ...position, owner, isOpen }, { longLots, shortLots }, { blockNumber, transactionHash, context })
  } else {
    const instrument = await getOrCreateInstrument({ chainId: event.chainId, positionId: positionId, context })
    const position = {
      id: createIdForPosition({ chainId: event.chainId, positionId }),
      chainId: event.chainId,
      proxyAddress: zeroAddress, // this will be set in UnderlyingPositonEvent handler
      positionId,
      owner: to,
      isOpen: true,
      createdAtBlock: event.block.number,
      createdAtTimestamp: event.block.timestamp,
      createdAtTransactionHash: event.transaction.hash,
      instrument_id: instrument.id,
      collateral: 0n,
      accruedLendingProfit: 0n,
      debt: 0n,
      accruedInterest: 0n,
      fees_long: 0n,
      fees_short: 0n,
      cashflowBase: 0n,
      cashflowQuote: 0n,
      firstLotId_long: createIdForLot({ chainId: event.chainId, positionId, blockNumber: event.block.number, accountingType: AccountingType.Long }),
      firstLotId_short: createIdForLot({ chainId: event.chainId, positionId, blockNumber: event.block.number, accountingType: AccountingType.Short }),
      realisedPnl_long: 0n,
      realisedPnl_short: 0n,
    }
    setPosition(position, { longLots: [], shortLots: [] }, { blockNumber: event.block.number, transactionHash: event.transaction.hash, context })
  }
});

export const createUnderlyingPositionId = ({ chainId, proxyAddress }: { chainId: number; proxyAddress: string; }) => `${chainId}_${proxyAddress.toLowerCase()}`

UnderlyingPositionFactory.UnderlyingPositionCreated.handler(async ({ event, context }) => {
  const id = createUnderlyingPositionId({ chainId: event.chainId, proxyAddress: event.params.account })
  const entity: UnderlyingPositionFactory_UnderlyingPositionCreated = {
    id,
    chainId: event.chainId,
    account: event.params.account,
    positionId: event.params.positionId,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
  };

  context.UnderlyingPositionFactory_UnderlyingPositionCreated.set(entity);

  const position = await getPosition({ chainId: event.chainId, positionId: event.params.positionId, context })
  setPosition({ ...position, proxyAddress: entity.account }, { longLots: [], shortLots: [] }, { blockNumber: event.block.number, transactionHash: event.transaction.hash, context })
});

export const createInstrumentId = ({ chainId, instrumentId }: { chainId: number; instrumentId: string; }) => `${chainId}_${instrumentId}`

ContangoProxy.InstrumentCreated.handler(async ({ event, context }) => {
  const { chainId, params } = event
  const [collateralToken, debtToken] = await Promise.all([
    getOrCreateToken({ address: params.base, chainId, context }),
    getOrCreateToken({ address: params.quote, chainId, context }),
  ]);

  const instrumentId = event.params.symbol.slice(0, 34)
  
  const entity: Instrument = {
    id: createInstrumentId({ chainId, instrumentId }),
    chainId: event.chainId,
    instrumentId,
    collateralToken_id: collateralToken.id,
    debtToken_id: debtToken.id,
    closingOnly: false,
  };

  context.Instrument.set(entity);

  const rawEventEntity: ContangoInstrumentCreatedEvent = {
    id: `${chainId}_${event.block.number}_${event.logIndex}`,
    chainId: event.chainId,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
    symbol: event.params.symbol,
    base: event.params.base,
    quote: event.params.quote,
  };

  context.ContangoInstrumentCreatedEvent.set(rawEventEntity);
});
