import { CompoundLiquidations } from "generated";
import { getContract, Hex, parseAbi } from "viem";
import { eventProcessor } from "../accounting/processTransactions";
import { clients } from "../clients";
import { getInterestToSettleOnLiquidation } from "../utils/common";
import { createEventId } from "../utils/ids";
import { EventType, LiquidationEvent } from "../utils/types";

const abi = parseAbi(["function exchangeRateCurrent() external view returns (uint256)"])
export const wadMul = (a: bigint, b: bigint) => (a * b) / BigInt(1e18)

CompoundLiquidations.LiquidateCompound.handler(async ({ event, context }) => {
  const snapshot = await eventProcessor.getOrLoadSnapshotFromProxyAddress(event, event.params.borrower, context)
  if (!snapshot) return
  const { position } = snapshot
  const { contangoPositionId } = position

  const { lendingProfitToSettle, debtCostToSettle } = await getInterestToSettleOnLiquidation({ chainId: event.chainId, blockNumber: event.block.number, position })
  const exchangeRate = await getContract({ abi, address: event.params.cTokenCollateral as Hex, client: clients[event.chainId] }).read.exchangeRateCurrent({ blockNumber: BigInt(event.block.number) })

  const liquidationEvent: LiquidationEvent = {
    id: createEventId({ ...event, eventType: EventType.LIQUIDATION }),
    chainId: event.chainId,
    contangoPositionId,
    collateralDelta: -wadMul(event.params.seizeTokens, exchangeRate),
    debtDelta: -event.params.repayAmount,
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