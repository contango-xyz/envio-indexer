import {
  CometLiquidations,
  CometLiquidations_LiquidateComet2_event,
  ContangoLiquidationEvent,
  handlerContext,
  Liquidations_LiquidateComet1
} from "generated";
import { eventsReducer } from "../accounting/processEvents";
import { getBalancesAtBlock, getPairForPositionId, getPosition } from "../utils/common";
import { createLiquidationId } from "../utils/ids";
import { max } from "../utils/math-helpers";
import { getLiquidationPenalty, getMarkPrice, getPositionIdForProxyAddress } from "./common";

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
    const step1Event = await getStep1Event(event, context)
    const balancesBefore = await getBalancesAtBlock(event.chainId, positionId, event.block.number - 1)

    const position = await getPosition({ chainId: event.chainId, positionId, context })
    const markPrice = await getMarkPrice({ chainId: event.chainId, positionId, blockNumber: event.block.number, context })

    const lendingProfitToSettle = max(balancesBefore.collateral - position.collateral, 0n)
    const debtCostToSettle = max(balancesBefore.debt - position.debt, 0n)
    const { collateralToken } = await getPairForPositionId({ chainId: event.chainId, positionId, context })

    const liquidationEvent: ContangoLiquidationEvent = {
      id: createLiquidationId({ chainId: event.chainId, blockNumber: event.block.number, transactionHash: event.transaction.hash, logIndex: event.logIndex }),
      chainId: event.chainId,
      positionId,
      collateralDelta: -step1Event.collateralAbsorbed,
      debtDelta: -event.params.basePaidOut,
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
      transactionHash: event.transaction.hash,
      lendingProfitToSettle,
      debtCostToSettle,
      liquidationPenalty: getLiquidationPenalty({ collateralToken, collateralDelta: step1Event.collateralAbsorbed, debtDelta: event.params.basePaidOut, markPrice }),
    }
    
    context.ContangoLiquidationEvent.set(liquidationEvent)
    context.Liquidations_LiquidateComet1.deleteUnsafe(`${event.chainId}_${event.transaction.hash}_comet1`)

    await eventsReducer(
      {
        chainId: event.chainId,
        blockNumber: event.block.number,
        transactionHash: event.transaction.hash,
        logIndex: event.logIndex,
        positionId,
        blockTimestamp: event.block.timestamp,
      },
      context
    )

  }

}, { wildcard: true });
