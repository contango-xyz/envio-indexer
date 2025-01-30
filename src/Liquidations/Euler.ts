import {
  ContangoLiquidationEvent,
  EulerLiquidations
} from "generated";
import { getContract, Hex, parseAbi } from "viem";
import { clients } from "../clients";
import { getMarkPrice, getPositionIdForProxyAddress, createLiquidationFillItem } from "./common";
import { createLiquidationId } from "../utils/ids";
import { getBalancesAtBlock } from "../utils/common";
import { EventType } from "../utils/types";

const eulerAbi = parseAbi(["function convertToAssets(uint256 shares) external view returns (uint256 assets)"])

EulerLiquidations.LiquidateEuler.handler(async ({ event, context }) => {
  const positionId = await getPositionIdForProxyAddress({ chainId: event.chainId, user: event.params.violator, context })

  if (positionId) {
    const collateralTaken = await getContract({
      abi: eulerAbi,
      address: event.params.collateral as Hex,
      client: clients[event.chainId],
    }).read.convertToAssets([event.params.yieldBalance], { blockNumber: BigInt(event.block.number) })
    const balancesBefore = await getBalancesAtBlock(event.chainId, positionId, event.block.number - 1)
    const markPrice = await getMarkPrice({ chainId: event.chainId, positionId, blockNumber: event.block.number, context })
    
    const liquidationEvent: ContangoLiquidationEvent = {
      id: createLiquidationId({ chainId: event.chainId, blockNumber: event.block.number, transactionHash: event.transaction.hash, logIndex: event.logIndex }),
      eventType: EventType.LIQUIDATION,
      chainId: event.chainId,
      positionId,
      collateralTaken,
      debtRepaid: event.params.repayAssets,
      tradedBy: event.params.liquidator,
      proxy: event.params.violator,
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
      transactionHash: event.transaction.hash,
      collateralBefore: balancesBefore.collateral,
      debtBefore: balancesBefore.debt,
      markPrice,
      srcContract: event.srcAddress,
    }
    context.ContangoLiquidationEvent.set(liquidationEvent)

    await createLiquidationFillItem({ liquidationEvent, context })
  }
}, { wildcard: true });
