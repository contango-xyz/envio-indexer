import {
  ContangoCollateralEvent,
  ContangoDebtEvent,
  ContangoInstrumentCreatedEvent,
  ContangoPositionUpsertedEvent,
  ContangoProxy,
  ContangoSwapEvent,
  handlerContext,
  Instrument,
  PositionNFT,
  UnderlyingPositionFactory,
  UnderlyingPositionFactory_UnderlyingPositionCreated
} from "generated";
import { Hex, toHex, zeroAddress } from "viem";
import { updateFillItemWithCashflowEvents } from "./ERC20";
import { erc20EventStore, eventStore } from "./Store";
import { addSwapsToFillItem } from "./SwapEvents";
import { AccountingType, accrueInterest, handleCostDelta, loadLots, processCollateralDelta, processDebtDelta, saveLots } from "./accounting/lots";
import { getOrCreateFillItem, handleCollateralAndDebtEvents_BeforeNewEventsExisted_new } from "./fillReducers";
import { getOrCreateInstrument, getPosition, getPositionSafe, setPosition } from "./utils/common";
import { getIMoneyMarketEventsStartBlock } from "./utils/constants";
import { getOrCreateToken } from "./utils/getTokenDetails";
import { createEventId, createIdForLot, createIdForPosition, createStoreKey } from "./utils/ids";
import { strategyContractsAddresses } from "./utils/previousContractAddresses";
import { ContangoEvents, EventType, GenericEvent } from "./utils/types";

export const processEvents = async ({ event, context }: { event: GenericEvent & { positionId: string }; context: handlerContext }) => {
  const { chainId, blockNumber, transactionHash } = event
  const positionMaybe = await getPosition({ chainId, positionId: event.positionId, context })
  if (!positionMaybe) throw new Error('No position found')
  const { positionId } = positionMaybe
  // in certain cases, the PositionUpserted event is the first indexed event emitted in the transaction
  let position = await getPosition({ chainId, positionId, context })
  const positionSnapshotBefore = { ...position }
  let fillItem = await getOrCreateFillItem({ ...event, blockNumber, positionId, transactionHash, context })

  // process swap events
  const unprocessedSwapEvents = eventStore.processEvents(
    createStoreKey({ ...event, blockNumber, transactionHash }),
    (event: ContangoEvents): event is ContangoSwapEvent => event.eventType === EventType.SWAP_EXECUTED
  )
  if (unprocessedSwapEvents.length > 0) {
    fillItem = await addSwapsToFillItem({ swapEvents: unprocessedSwapEvents, fillItem, context })
  }

  let lots = await loadLots({ position, context })

  // if wer're processing a block that's before when the new IMoneyMarket events were added, we need a fallback
  if (blockNumber <= getIMoneyMarketEventsStartBlock(event.chainId, context)) {
    const upsertedEvents = eventStore.processEvents(
      createStoreKey({ ...event, blockNumber, transactionHash }),
      (event: ContangoEvents): event is ContangoPositionUpsertedEvent => event.eventType === EventType.POSITION_UPSERTED
    )
    if (upsertedEvents.length > 1) throw new Error('Multiple PositionUpserted events being processed at once')
    const upsertedEvent = { ...upsertedEvents[0] }
    const debtDeltaBefore = fillItem.debtDelta
    fillItem = await handleCollateralAndDebtEvents_BeforeNewEventsExisted_new({ upsertedEvent, chainId: event.chainId, fillItem, context })  
    lots = await accrueInterest({ lots, context, debtCostToSettle: fillItem.debtCostToSettle, lendingProfitToSettle: fillItem.lendingProfitToSettle })
    await processCollateralDelta({ ...event, position, context, collateralDelta: upsertedEvent.quantityDelta, lots })
    const debtDelta = fillItem.debtDelta - debtDeltaBefore
    await processDebtDelta({ ...event, position, context, debtDelta, lots })

    position.debt += fillItem.debtDelta
    position.collateral += upsertedEvent.quantityDelta
  } else {
    const debtEvents = eventStore.processEvents(
      createStoreKey({ ...event, blockNumber, transactionHash }),
      (event: ContangoEvents): event is ContangoDebtEvent => event.eventType === EventType.DEBT
    )
  
    const collateralEvents = eventStore.processEvents(
      createStoreKey({ ...event, blockNumber, transactionHash }),
      (event: ContangoEvents): event is ContangoCollateralEvent => event.eventType === EventType.COLLATERAL
    )
    
    const debtBalanceOnPosition = position.debt + position.accruedInterest
    const debtBalanceSnapshot = debtEvents.reduce((_, debtEvent) => debtEvent.balanceBefore, debtBalanceOnPosition)
    const debtCostToSettle = debtBalanceSnapshot - debtBalanceOnPosition
    const debtDelta = debtEvents.reduce((acc, debtEvent) => acc + debtEvent.debtDelta, 0n)
    position.debt += debtDelta
    fillItem.debtDelta += debtDelta
  
    // make sure to only set this once per transaction
    if (fillItem.debtCostToSettle === 0n && debtCostToSettle > 0n) {
      fillItem.debtCostToSettle = debtCostToSettle
      position.accruedInterest += debtCostToSettle
    }
  
    const collateralBalanceOnPosition = position.accruedLendingProfit + position.collateral
    const collateralBalanceSnapshot = collateralEvents.reduce((_, collateralEvent) => collateralEvent.balanceBefore, collateralBalanceOnPosition)
    const lendingProfitToSettle = collateralBalanceSnapshot - collateralBalanceOnPosition
    const collateralDelta = collateralEvents.reduce((acc, collateralEvent) => acc + collateralEvent.collateralDelta, 0n)
    position.collateral += collateralDelta
    fillItem.collateralDelta += collateralDelta
  
    // make sure to only set this once per transaction
    if (lendingProfitToSettle > 0n || debtCostToSettle > 0n) {
      fillItem.lendingProfitToSettle = lendingProfitToSettle
      position.accruedLendingProfit += lendingProfitToSettle
      lots = await accrueInterest({ lots, context, debtCostToSettle, lendingProfitToSettle})
    }

    await processCollateralDelta({ ...event, position, context, collateralDelta, lots })
    await processDebtDelta({ ...event, position, context, debtDelta, lots })
  }

  const cashflowBaseSnapshot = fillItem.cashflowBase
  const cashflowQuoteSnapshot = fillItem.cashflowQuote

  const erc20TransferEvents = erc20EventStore.processEvents(event.chainId)
  for (const event of erc20TransferEvents) {
    fillItem = await updateFillItemWithCashflowEvents({ fillItem, position, event, context })
  }

  const cashflowBase = fillItem.cashflowBase - cashflowBaseSnapshot
  const cashflowQuote = fillItem.cashflowQuote - cashflowQuoteSnapshot
  position.cashflowBase += cashflowBase
  position.cashflowQuote += cashflowQuote

  // lots.shortLots = await handleCostDelta({ lots: lots.shortLots, context, position, costDelta: cashflowBase, accountingType: AccountingType.Short, ...event })
  lots.longLots = await handleCostDelta({ lots: lots.longLots, context, position, costDelta: cashflowQuote, accountingType: AccountingType.Long, ...event })
  saveLots({ lots: [...lots.longLots, ...lots.shortLots], context })

  fillItem.realisedPnl_long += position.realisedPnl_long - positionSnapshotBefore.realisedPnl_long
  fillItem.realisedPnl_short += position.realisedPnl_short - positionSnapshotBefore.realisedPnl_short

  context.FillItem.set(fillItem)

  const newPosition = {
    ...position,
    fees_long: position.fees_long + fillItem.fee_long,
    fees_short: position.fees_short + fillItem.fee_short,
  }
  
  // save the position, and put it into the store context
  setPosition(newPosition, { blockNumber: event.blockNumber, transactionHash: event.transactionHash, context })
  // cleanup the store. At this point we should have processed all stored events ()
  eventStore.cleanup(event.chainId, event.blockNumber)
}

ContangoProxy.PositionUpserted.handler(async ({ event, context}) => {
  const eventId = createEventId({ eventType: EventType.POSITION_UPSERTED, chainId: event.chainId, blockNumber: event.block.number, transactionHash: event.transaction.hash, logIndex: event.logIndex })
  const upsertedEvent: ContangoPositionUpsertedEvent = {
    ...event.params,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    chainId: event.chainId,
    eventType: EventType.POSITION_UPSERTED,
    id: eventId,
    transactionHash: event.transaction.hash,
  }

  eventStore.addLog({ eventId, contangoEvent: upsertedEvent })

  await processEvents({ event: { ...upsertedEvent, logIndex: event.logIndex, blockNumber: event.block.number, transactionHash: event.transaction.hash, blockTimestamp: event.block.timestamp }, context })
})

// On create, the NFT transfer event is emitted before the UnderlyingPositionCreated event
PositionNFT.Transfer.handler(async ({ event, context }) => {
  const { block: { number: blockNumber }, transaction: { hash: transactionHash } } = event
  const positionId = toHex(event.params.tokenId, { size: 32 }).toLowerCase() as Hex

  const position = await getPositionSafe({ chainId: event.chainId, positionId, context })

  if (position) {

    const isTransferToStrategyBuilder = strategyContractsAddresses(event.chainId).has(event.params.to as Hex)
    // if the transfer is to the strategy builder, we don't update the owner.
    // This is important because when we evaluate cashflows, we need to know the cashflows of the actual owner and not the "temporary" owner
    const owner = isTransferToStrategyBuilder ? position.owner : event.params.to
    const isOpen = event.params.to !== zeroAddress // update isOpen when NFT is transferred to the zero address

    setPosition({ ...position, owner, isOpen }, { blockNumber, transactionHash, context })
  } else {
    const owner = event.params.to
    const instrument = await getOrCreateInstrument({ chainId: event.chainId, positionId: positionId, context })
    const position = {
      id: createIdForPosition({ chainId: event.chainId, positionId }),
      chainId: event.chainId,
      proxyAddress: zeroAddress, // this will be set in UnderlyingPositonEvent handler
      positionId,
      owner,
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
    setPosition(position, { blockNumber: event.block.number, transactionHash: event.transaction.hash, context })
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
  setPosition({ ...position, proxyAddress: entity.account }, { blockNumber: event.block.number, transactionHash: event.transaction.hash, context })
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
