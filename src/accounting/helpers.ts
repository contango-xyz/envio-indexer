import { ERC20_Transfer_event, FillItem, Position, Token } from "generated";
import { PartialFillItem } from "./processEvents";
import { TRADER } from "../ERC20";
import { vaultProxy } from "../ERC20";
import { contangoProxy } from "../ERC20";
import { createTokenId } from "../utils/getTokenDetails";
import { max, mulDiv } from "../utils/math-helpers";
import { createFillItemId } from "../utils/ids";
import { FillItemType } from "../utils/types";
import { GenericEvent } from "./lotsAccounting";

export const createEmptyPartialFillItem = ({ collateralToken, debtToken }: { collateralToken: Token; debtToken: Token; }): PartialFillItem => ({
  collateralToken,
  debtToken,
  tradePrice_long: 0n,
  tradePrice_short: 0n,
  collateralDelta: 0n,
  debtDelta: 0n,
  debtCostToSettle: 0n,
  lendingProfitToSettle: 0n,
  fee: 0n,
  cashflowSwap: undefined,
  liquidationPenalty: 0n,
})

export const filterERC20TransferEvents = (event: ERC20_Transfer_event, position: Position) => {
  const [from, to, owner] = [event.params.from.toLowerCase(), event.params.to.toLowerCase(), position.owner.toLowerCase()]
  return (to === vaultProxy && from === owner) || (to === contangoProxy && from === vaultProxy)
}

type PartialFillItemWithCashflow = PartialFillItem & {
  cashflowQuote: bigint
  cashflowBase: bigint
  cashflow: bigint
  cashflowToken_id?: string
}

export const updateFillItemWithCashflowEvents = (
  {
    event,
    fillItem,
    owner: _owner,
  }: { fillItem: PartialFillItemWithCashflow; owner: string; event: ERC20_Transfer_event }
): PartialFillItemWithCashflow => {

  const { collateralToken, debtToken } = fillItem
  const [owner, from, to, srcAddress] = [_owner, event.params.from, event.params.to, event.srcAddress].map(a => a.toLowerCase())

  let { cashflowQuote, cashflowBase, cashflow, cashflowToken_id } = fillItem

  const assignCashflowTokenId = () => {
    if ([cashflowQuote, cashflowBase, cashflow].every(a => a === 0n)) {
      cashflowToken_id = createTokenId({ chainId: event.chainId, address: srcAddress })
    }
  }
  
  if ([owner, TRADER].includes(from)) {
    // only set if empty (a second transfer event will always be the less meaningful one - for example a dust sweep)
    assignCashflowTokenId()

    if (debtToken.address === srcAddress) cashflowQuote += event.params.value
    else if (collateralToken.address === srcAddress) cashflowBase += event.params.value
    else cashflow += event.params.value
  } else if ([owner, TRADER].includes(to)) {
    // only set if empty (a second transfer event will always be the less meaningful one - for example a dust sweep)
    assignCashflowTokenId()

    if (debtToken.address === srcAddress) cashflowQuote -= event.params.value
    else if (collateralToken.address === srcAddress) cashflowBase -= event.params.value
    else cashflow -= event.params.value
  }

  return { ...fillItem, cashflowQuote, cashflowBase, cashflow, cashflowToken_id }
}

export const partialFillItemWithCashflowEventsToFillItem = (partialFillItem: PartialFillItemWithCashflow, position: Position, event: GenericEvent) => {

  const { collateralToken, debtToken } = partialFillItem

  let cashflowBase = partialFillItem.cashflowBase
  let cashflowQuote = partialFillItem.cashflowQuote

  const { cashflowSwap } = partialFillItem

  if (cashflowSwap) {
    if (cashflowSwap.tokenOut_id === debtToken.id) {
      cashflowQuote += cashflowSwap.amountOut
    } else if (cashflowSwap.tokenOut_id === collateralToken.id) {
      cashflowBase += cashflowSwap.amountOut
    } else if (cashflowSwap.tokenIn_id === debtToken.id) {
      cashflowQuote -= cashflowSwap.amountIn
    } else if (cashflowSwap.tokenIn_id === collateralToken.id) {
      cashflowBase -= cashflowSwap.amountIn
    }
  }

  cashflowQuote += mulDiv(cashflowBase, partialFillItem.tradePrice_long, collateralToken.unit)
  cashflowBase += mulDiv(cashflowQuote, collateralToken.unit, partialFillItem.tradePrice_long)

  let fee_long = 0n
  let fee_short = 0n

  if (partialFillItem.feeToken_id === collateralToken.id) {
    fee_short = partialFillItem.fee
    fee_long = mulDiv(partialFillItem.fee, partialFillItem.tradePrice_long, collateralToken.unit)
  } else if (partialFillItem.feeToken_id === debtToken.id) {
    fee_long = partialFillItem.fee
    fee_short = mulDiv(partialFillItem.fee, partialFillItem.tradePrice_short, debtToken.unit)
  }

  return {
    ...event,
    ...partialFillItem,
    id: createFillItemId({ ...event, positionId: position.id }),
    cashflowQuote,
    cashflowBase,
    fillItemType: FillItemType.Trade,
    fee_long,
    fee_short,
    liquidationPenalty: 0n,
    positionId: position.id,
    realisedPnl_long: 0n,
    realisedPnl_short: 0n,
    timestamp: event.blockTimestamp,
    cashflowSwap_id: cashflowSwap?.id,
    feeToken_id: partialFillItem.feeToken_id,
    debtCostToSettle: partialFillItem.debtCostToSettle,
    lendingProfitToSettle: partialFillItem.lendingProfitToSettle,
  }
}
