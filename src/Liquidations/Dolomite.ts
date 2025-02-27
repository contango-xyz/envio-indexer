import {
  ContangoLiquidationEvent,
  DolomiteLiquidations
} from "generated";
import { eventsReducer } from "../accounting/processEvents";
import { eventStore } from "../Store";
import { getBalancesAtBlock, getMarkPrice } from "../utils/common";
import { createEventId } from "../utils/ids";
import { max } from "../utils/math-helpers";
import { EventType } from "../utils/types";
import { getLiquidationPenalty, getPositionIdForProxyAddress } from "./common";

DolomiteLiquidations.LiquidateDolomite.handler(async ({ event, context }) => {
  const positionId = await getPositionIdForProxyAddress({ chainId: event.chainId, user: event.params.solidAccountOwner, context })

  if (positionId) {
    const snapshot = await eventStore.getCurrentPositionSnapshot({ event: { ...event, params: { positionId } }, context })
    if (!snapshot) {
      console.error(`no snapshot found for positionId: ${positionId} - chainId: ${event.chainId}`, event)
      return
    }

    const { position, collateralToken, debtToken } = snapshot
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
      collateralDelta: -event.params.liquidHeldUpdateValue,
      debtDelta: -event.params.liquidOwedUpdateValue,
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
      transactionHash: event.transaction.hash,
      lendingProfitToSettle,
      debtCostToSettle,
      liquidationPenalty: getLiquidationPenalty({ collateralToken, collateralDelta: event.params.liquidHeldUpdateValue, debtDelta: event.params.liquidOwedUpdateValue, markPrice }),
      markPrice,
    }
    context.ContangoLiquidationEvent.set(liquidationEvent)
    eventStore.addLog({ event: { ...event, params: { positionId } }, contangoEvent: { ...liquidationEvent, eventType: EventType.LIQUIDATION } })

    await eventsReducer({ ...snapshot, context })
  }
}, { wildcard: true });