import { SiloLiquidations } from "generated";
import { getInterestToSettleOnLiquidation } from "../utils/common";
import { createEventId } from "../utils/ids";
import { EventType, LiquidationEvent } from "../utils/types";
import { getPositionForProxy } from "./common";
import { eventProcessor } from "../accounting/processTransactions";

const temp: Record<number, { seizedCollateral: bigint, shareAmountRepaid: bigint }> = {}

SiloLiquidations.LiquidateSilo.handler(async ({ event, context }) => {
  const position = await getPositionForProxy({ chainId: event.chainId, proxyAddress: event.params.user, context })
  if (!position) return
  const { contangoPositionId } = position

  temp[event.chainId] = temp[event.chainId] || { seizedCollateral: 0n, shareAmountRepaid: 0n }
  temp[event.chainId].seizedCollateral += event.params.seizedCollateral
  temp[event.chainId].shareAmountRepaid += event.params.shareAmountRepaid

  const { lendingProfitToSettle, debtCostToSettle } = await getInterestToSettleOnLiquidation({ chainId: event.chainId, blockNumber: event.block.number, position })

  const { seizedCollateral, shareAmountRepaid } = temp[event.chainId]

  if (seizedCollateral !== 0n && shareAmountRepaid !== 0n) {
      const liquidationEvent: LiquidationEvent = {
        id: createEventId({ ...event, eventType: EventType.LIQUIDATION }),
        chainId: event.chainId,
        contangoPositionId,
        collateralDelta: -seizedCollateral,
        debtDelta: -shareAmountRepaid,
        blockNumber: event.block.number,
        blockTimestamp: event.block.timestamp,
        transactionHash: event.transaction.hash,
        lendingProfitToSettle,
        debtCostToSettle,
        cashflowInDebtToken: 0n,
        eventType: EventType.LIQUIDATION,
      }
      
      await eventProcessor.processEvent(liquidationEvent, context)

      temp[event.chainId] = { seizedCollateral: 0n, shareAmountRepaid: 0n }
  }
}, { wildcard: true });
