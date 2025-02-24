import {
  CometLiquidations,
  CometLiquidations_LiquidateComet2_event,
  ContangoLiquidationEvent,
  handlerContext,
  Liquidations_LiquidateComet1
} from "generated";
import { eventsReducer } from "../accounting/processEvents";
import { eventStore } from "../Store";
import { getBalancesAtBlock, getMarkPrice } from "../utils/common";
import { createEventId } from "../utils/ids";
import { max } from "../utils/math-helpers";
import { EventType } from "../utils/types";
import { getLiquidationPenalty, getPositionIdForProxyAddress } from "./common";

CometLiquidations.LiquidateComet1.handler(async ({ event, context }) => {
  const positionId = await getPositionIdForProxyAddress({ chainId: event.chainId, user: event.params.borrower, context })
  if (positionId) {
    const entity: Liquidations_LiquidateComet1 = {
      id: `${event.chainId}_${event.transaction.hash}_comet1`,
      chainId: event.chainId,
      absorber: event.params.absorber,
      borrower: event.params.borrower,
      asset: event.params.asset,
      collateralAbsorbed: event.params.collateralAbsorbed,
      usdValue: event.params.usdValue,
      };
    context.Liquidations_LiquidateComet1.set(entity);
  }
}, { wildcard: true });

const getStep1Event = async (event: CometLiquidations_LiquidateComet2_event, context: handlerContext) => {
  const step1Event = await context.Liquidations_LiquidateComet1.get(`${event.chainId}_${event.transaction.hash}_comet1`)
  if (!step1Event) {
    throw new Error(`Step 1 event not found for transaction ${event.transaction.hash} on chain ${event.chainId}`)
  }
  return step1Event
}

CometLiquidations.LiquidateComet2.handler(async ({ event, context }) => {
  const positionId = await getPositionIdForProxyAddress({ chainId: event.chainId, user: event.params.borrower, context })
  
  if (positionId) {
    const snapshot = await eventStore.getCurrentPositionSnapshot({ event: { ...event, params: { positionId } }, context })
    if (!snapshot) {
      console.error(`no snapshot found for positionId: ${positionId} - chainId: ${event.chainId}`, event)
      return
    }
    const { position, collateralToken, debtToken } = snapshot
    const step1Event = await getStep1Event(event, context)
    const [balancesBefore, markPrice] = await Promise.all([
      getBalancesAtBlock(event.chainId, positionId, event.block.number - 1),
      getMarkPrice({ chainId: event.chainId, positionId, blockNumber: event.block.number, debtToken })
    ])

    const lendingProfitToSettle = max(balancesBefore.collateral - position.collateral, 0n)
    const debtCostToSettle = max(balancesBefore.debt - position.debt, 0n)

    const liquidationEvent: ContangoLiquidationEvent = {
      id: createEventId({ ...event, eventType: EventType.LIQUIDATION }),
      chainId: event.chainId,
      contangoPositionId: positionId,
      collateralDelta: -step1Event.collateralAbsorbed,
      debtDelta: -event.params.basePaidOut,
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
      transactionHash: event.transaction.hash,
      lendingProfitToSettle,
      debtCostToSettle,
      liquidationPenalty: getLiquidationPenalty({ collateralToken, collateralDelta: step1Event.collateralAbsorbed, debtDelta: event.params.basePaidOut, markPrice }),
      markPrice,
    }
    
    context.ContangoLiquidationEvent.set(liquidationEvent)
    context.Liquidations_LiquidateComet1.deleteUnsafe(`${event.chainId}_${event.transaction.hash}_comet1`)
    eventStore.addLog({ event: { ...event, params: { positionId } }, contangoEvent: { ...liquidationEvent, eventType: EventType.LIQUIDATION } })

    await eventsReducer({ ...snapshot, context })
  }

}, { wildcard: true });