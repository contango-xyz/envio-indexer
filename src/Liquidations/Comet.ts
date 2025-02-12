import {
  CometLiquidations,
  CometLiquidations_LiquidateComet2_event,
  ContangoLiquidationEvent,
  handlerContext,
  Liquidations_LiquidateComet1
} from "generated";
import { getMarkPrice, getPositionIdForProxyAddress, createLiquidationFillItem } from "./common";
import { createLiquidationId } from "../utils/ids";
import { getBalancesAtBlock, getPosition } from "../utils/common";
import { EventType } from "../utils/types";
import { max } from "../utils/math-helpers";

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

    const collateralBefore = max(balancesBefore.collateral, position.collateral)
    const debtBefore = max(balancesBefore.debt, position.debt)

    const liquidationEvent: ContangoLiquidationEvent = {
      id: createLiquidationId({ chainId: event.chainId, blockNumber: event.block.number, transactionHash: event.transaction.hash, logIndex: event.logIndex }),
      eventType: EventType.LIQUIDATION,
      chainId: event.chainId,
      positionId,
      collateralTaken: step1Event.collateralAbsorbed,
      debtRepaid: event.params.basePaidOut,
      tradedBy: event.params.absorber,
      proxy: step1Event.borrower,
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
      transactionHash: event.transaction.hash,
      collateralBefore,
      debtBefore,
      markPrice,
      srcContract: event.srcAddress,
    }
    
    context.ContangoLiquidationEvent.set(liquidationEvent)
    context.Liquidations_LiquidateComet1.deleteUnsafe(`${event.chainId}_${event.transaction.hash}_comet1`)

    await createLiquidationFillItem({ liquidationEvent, context })
  }

}, { wildcard: true });
