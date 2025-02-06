import {
  ContangoCollateralEvent,
  ContangoDebtEvent,
  ContangoInstrumentCreatedEvent,
  ContangoProxy,
  ContangoSwapEvent,
  Instrument,
  PositionNFT,
  UnderlyingPositionFactory,
  UnderlyingPositionFactory_UnderlyingPositionCreated
} from "generated";
import { Hex, toHex, zeroAddress } from "viem";
import { updateFillItemWithCashflowEvents } from "./ERC20";
import { erc20EventStore, eventStore } from "./Store";
import { addSwapsToFillItem } from "./SwapEvents";
import { AccountingType, accrueInterest, loadLots, processCashflowDelta, processCollateralDelta, processDebtDelta, saveLots } from "./accounting/lots";
import { getOrCreateFillItem, handleCollateralAndDebtEvents_BeforeNewEventsExisted } from "./fillReducers";
import { getInstrument, getPosition, getPositionSafe, setPosition } from "./utils/common";
import { getIMoneyMarketEventsStartBlock } from "./utils/constants";
import { getOrCreateToken } from "./utils/getTokenDetails";
import { createIdForLot, createIdForPosition, createStoreKey } from "./utils/ids";
import { strategyContractsAddresses } from "./utils/previousContractAddresses";
import { ContangoEvents, EventType, GenericEvent } from "./utils/types";

// deploy
ContangoProxy.PositionUpserted.handler(async ({ event, context }) => {
  // in certain cases, the PositionUpserted event is the first indexed event emitted in the transaction
  const { block: { timestamp: blockTimestamp, number: blockNumber }, chainId, transaction: { hash: transactionHash } } = event
  let position = await getPosition({ chainId, positionId: event.params.positionId, context })
  const positionSnapshotBefore = { ...position }
  let fillItem = await getOrCreateFillItem({ ...event, blockTimestamp, blockNumber, positionId: event.params.positionId, transactionHash, context })

  // process swap events
  const unprocessedSwapEvents = eventStore.processEvents(
    createStoreKey({ ...event, blockNumber, transactionHash }),
    (event: ContangoEvents): event is ContangoSwapEvent => event.eventType === EventType.SWAP_EXECUTED
  )
  if (unprocessedSwapEvents.length > 0) {
    fillItem = await addSwapsToFillItem({ swapEvents: unprocessedSwapEvents, fillItem, context })
  }

  // if wer're processing a block that's before when the new IMoneyMarket events were added, we need a fallback
  if (event.block.number <= getIMoneyMarketEventsStartBlock(event.chainId, context)) {
    fillItem = await handleCollateralAndDebtEvents_BeforeNewEventsExisted({ upsertedEvent: event, chainId: event.chainId, blockNumber: event.block.number, fillItem, context })  
  }

  const debtEvents = eventStore.processEvents(
    createStoreKey({ ...event, blockNumber, transactionHash }),
    (event: ContangoEvents): event is ContangoDebtEvent => event.eventType === EventType.DEBT
  )

  const collateralEvents = eventStore.processEvents(
    createStoreKey({ ...event, blockNumber, transactionHash }),
    (event: ContangoEvents): event is ContangoCollateralEvent => event.eventType === EventType.COLLATERAL
  )

  for (const debtEvent of debtEvents) {
    fillItem.debtDelta += debtEvent.debtDelta
    fillItem.debtCostToSettle = debtEvent.balanceBefore - (position.debt + position.accruedInterest)
  }

  for (const collateralEvent of collateralEvents) {
    fillItem.collateralDelta += collateralEvent.collateralDelta
    fillItem.lendingProfitToSettle = collateralEvent.balanceBefore - (position.accruedLendingProfit + position.collateral)
  }

  const genericEvent: GenericEvent = { ...event, blockNumber, transactionHash: event.transaction.hash, blockTimestamp: event.block.timestamp }
  let lots = await loadLots({ position, context })
  
  lots = await accrueInterest({
    lots,
    context,
    debtCostToSettle: fillItem.debtCostToSettle,
    lendingProfitToSettle: fillItem.lendingProfitToSettle
  })
  
  await processCollateralDelta({ ...genericEvent, position, context, collateralDelta: fillItem.collateralDelta, lots })
  await processDebtDelta({ ...genericEvent, position, context, debtDelta: fillItem.debtDelta, lots })

  const erc20TransferEvents = erc20EventStore.processEvents(event.chainId)
  for (const event of erc20TransferEvents) {
    fillItem = await updateFillItemWithCashflowEvents({ fillItem, position, event, context })
  }

  await processCashflowDelta({ ...genericEvent, position, context, cashflowDelta: fillItem.cashflowQuote, lots })

  await saveLots({ lots: [...lots.longLots, ...lots.shortLots], context })

  fillItem.realisedPnl_long = position.realisedPnl_long - positionSnapshotBefore.realisedPnl_long
  fillItem.realisedPnl_short = position.realisedPnl_short - positionSnapshotBefore.realisedPnl_short

  context.FillItem.set(fillItem)

  context.Position.set({
    ...position,
    cashflowBase: position.cashflowBase + fillItem.cashflowBase,
    cashflowQuote: position.cashflowQuote + fillItem.cashflowQuote,
    collateral: position.collateral + fillItem.collateralDelta,
    debt: position.debt + fillItem.debtDelta,
    accruedLendingProfit: position.accruedLendingProfit + fillItem.lendingProfitToSettle,
    accruedInterest: position.accruedInterest + fillItem.debtCostToSettle,
    fees_long: position.fees_long + fillItem.fee_long,  
    fees_short: position.fees_short + fillItem.fee_short,
  })

  // cleanup the store. At this point we should have processed all stored events ()
  eventStore.cleanup(event.chainId, event.block.number)
});

// On create, the NFT transfer event is emitted before the UnderlyingPositionCreated event
PositionNFT.Transfer.handler(async ({ event, context }) => {
  const { block: { number: blockNumber, timestamp: blockTimestamp, hash: blockHash }, transaction: { hash: transactionHash } } = event
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
    const instrument = await getInstrument({ chainId: event.chainId, positionId: positionId, context })
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
