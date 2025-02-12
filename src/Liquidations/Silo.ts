import {
  ContangoLiquidationEvent,
  SiloLiquidations
} from "generated";
import { zeroAddress } from "viem";
import { getMarkPrice, getPositionIdForProxyAddress, createLiquidationFillItem } from "./common";
import { createLiquidationId } from "../utils/ids";
import { getBalancesAtBlock, getPosition } from "../utils/common";
import { EventType } from "../utils/types";
import { max } from "../utils/math-helpers";

SiloLiquidations.LiquidateSilo.handler(async ({ event, context }) => {
  const positionId = await getPositionIdForProxyAddress({ chainId: event.chainId, user: event.params.user, context })

  if (positionId) {
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
      collateralTaken: event.params.seizedCollateral,
      debtRepaid: event.params.shareAmountRepaid,
      tradedBy: zeroAddress, // Silo doesn't have a liquidator on the event
      proxy: event.params.user,
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
      transactionHash: event.transaction.hash,
      collateralBefore,
      debtBefore,
      markPrice,
      srcContract: event.srcAddress,
    }
    context.ContangoLiquidationEvent.set(liquidationEvent)

    await createLiquidationFillItem({ liquidationEvent, context })
  }
}, { wildcard: true });
