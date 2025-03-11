import { EulerLiquidations } from "generated";
import { Hex, getContract, parseAbi } from "viem";
import { eventProcessor } from "../accounting/processTransactions";
import { clients } from "../clients";
import { getInterestToSettleOnLiquidation } from "../utils/common";
import { createEventId } from "../utils/ids";
import { EventType, LiquidationEvent } from "../utils/types";
import { getPositionForProxy } from "./common";

const eulerAbi = parseAbi(["function convertToAssets(uint256 shares) external view returns (uint256 assets)"])

EulerLiquidations.LiquidateEuler.handler(async ({ event, context }) => {
  const position = await getPositionForProxy({ chainId: event.chainId, proxyAddress: event.params.violator, context })
  if (!position) return
  
  const { contangoPositionId } = position

  const collateralTaken = await getContract({
    abi: eulerAbi,
    address: event.params.collateral as Hex,
    client: clients[event.chainId],
  }).read.convertToAssets([event.params.yieldBalance], { blockNumber: BigInt(event.block.number) })

  const { lendingProfitToSettle, debtCostToSettle } = await getInterestToSettleOnLiquidation({ chainId: event.chainId, blockNumber: event.block.number, position })
  
  const liquidationEvent: LiquidationEvent = {
    id: createEventId({ ...event, eventType: EventType.LIQUIDATION }),
    chainId: event.chainId,
    contangoPositionId,
    collateralDelta: -collateralTaken,
    debtDelta: -event.params.repayAssets,
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