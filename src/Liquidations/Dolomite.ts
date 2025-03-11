import { DolomiteLiquidations } from "generated";
import { getInterestToSettleOnLiquidation } from "../utils/common";
import { createEventId } from "../utils/ids";
import { EventType, LiquidationEvent } from "../utils/types";
import { getPositionForProxy } from "./common";
import { eventProcessor } from "../accounting/processTransactions";


DolomiteLiquidations.LiquidateDolomite.handler(async ({ event, context }) => {
  const position = await getPositionForProxy({ chainId: event.chainId, proxyAddress: event.params.solidAccountOwner, context })
  if (!position) return
  const { contangoPositionId } = position

  const { lendingProfitToSettle, debtCostToSettle } = await getInterestToSettleOnLiquidation({ chainId: event.chainId, blockNumber: event.block.number, position })

  const liquidationEvent: LiquidationEvent = {
    id: createEventId({ ...event, eventType: EventType.LIQUIDATION }),
    chainId: event.chainId,
    contangoPositionId,
    collateralDelta: -event.params.liquidHeldUpdateValue,
    debtDelta: -event.params.liquidOwedUpdateValue,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
    lendingProfitToSettle,
    debtCostToSettle,
    cashflowInDebtToken: 0n,
    eventType: EventType.LIQUIDATION,
  }

  await eventProcessor.processEvent(liquidationEvent, context)
}, { wildcard: true });