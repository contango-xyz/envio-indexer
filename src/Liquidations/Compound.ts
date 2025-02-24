import {
  CompoundLiquidations,
  ContangoLiquidationEvent
} from "generated";
import { eventsReducer } from "../accounting/processEvents";
import { eventStore } from "../Store";
import { getBalancesAtBlock, getMarkPrice } from "../utils/common";
import { createEventId, createFillItemId } from "../utils/ids";
import { max } from "../utils/math-helpers";
import { EventType } from "../utils/types";
import { getLiquidationPenalty, getPositionIdForProxyAddress } from "./common";
import { getContract, Hex, parseAbi } from "viem";
import { clients } from "../clients";

const abi = parseAbi(["function exchangeRateCurrent() external view returns (uint256)"])
export const wadMul = (a: bigint, b: bigint) => (a * b) / BigInt(1e18)

CompoundLiquidations.LiquidateCompound.handler(async ({ event, context }) => {
  const positionId = await getPositionIdForProxyAddress({ chainId: event.chainId, user: event.params.borrower, context })

  if (positionId) {
    const snapshot = await eventStore.getCurrentPositionSnapshot({ event: { ...event, params: { positionId } }, context })
    if (!snapshot) {
      console.error(`no snapshot found for positionId: ${positionId} - chainId: ${event.chainId}`, event)
      return
    }

    const { position, debtToken, collateralToken } = snapshot
    const [balancesBefore, markPrice] = await Promise.all([
      getBalancesAtBlock(event.chainId, positionId, event.block.number - 1),
      getMarkPrice({ chainId: event.chainId, positionId, blockNumber: event.block.number, debtToken })
    ])

    const lendingProfitToSettle = max(balancesBefore.collateral - position.collateral, 0n)
    const debtCostToSettle = max(balancesBefore.debt - position.debt, 0n)
    const exchangeRate = await getContract({ abi, address: event.params.cTokenCollateral as Hex, client: clients[event.chainId] }).read.exchangeRateCurrent({ blockNumber: BigInt(event.block.number) })

    const liquidationEvent: ContangoLiquidationEvent = {
      id: createEventId({ ...event, eventType: EventType.LIQUIDATION }),
      chainId: event.chainId,
      contangoPositionId: positionId,
      collateralDelta: -wadMul(event.params.seizeTokens, exchangeRate),
      debtDelta: -event.params.repayAmount,
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
      transactionHash: event.transaction.hash,
      lendingProfitToSettle,
      debtCostToSettle,
      liquidationPenalty: getLiquidationPenalty({ collateralToken, collateralDelta: event.params.seizeTokens, debtDelta: event.params.repayAmount, markPrice }),
      markPrice,
    }
    context.ContangoLiquidationEvent.set(liquidationEvent)
    eventStore.addLog({ event: { ...event, params: { positionId } }, contangoEvent: { ...liquidationEvent, eventType: EventType.LIQUIDATION } })

    await eventsReducer({ ...snapshot, context })
  }
}, { wildcard: true });