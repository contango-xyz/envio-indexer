import { Position, Token } from "generated";
import { zeroAddress } from "viem";
import { ADDRESSES, wrappedNativeMap } from "../../utils/constants";
import { createTokenId } from "../../utils/getTokenDetails";
import { absolute, mulDiv } from "../../utils/math-helpers";
import { FeeCollectedEvent, TransferEvent } from "../../utils/types";
import { FillItemWithPricesFeesDebtAndCollateral } from "./debtAndCollateral";

export const withCashflowsAndFee = ({ position, fillItem, debtToken, collateralToken, transferEvents, feeEvent }: { feeEvent?: FeeCollectedEvent; position: Position; fillItem: FillItemWithPricesFeesDebtAndCollateral; debtToken: Token; collateralToken: Token; transferEvents: TransferEvent[]; }) => {
  const cashflows = calculateNetCashflows(transferEvents, position)

  return {
    ...fillItem,
    ...calculateCashflowsAndFee({ position, fillItem, debtToken, collateralToken, cashflows, feeEvent })
  }
}

type AddressHoldingFunds = string
type TokenAddress = string
type CashflowRecordInner = Record<TokenAddress, bigint>
type CashflowRecord = Record<AddressHoldingFunds, CashflowRecordInner>

export const calculateNetCashflows = (events: TransferEvent[], position: Position): CashflowRecord => {
  return events
    .reduce((acc, e) => {
      let [from, to, srcAddress] = [e.from, e.to, e.srcAddress].map(x => x.toLowerCase())
      const fromPrev = acc[srcAddress]?.[from] ?? 0n
      const toPrev = acc[srcAddress]?.[to] ?? 0n

      return {
        ...acc,
        [srcAddress]: {
          ...(acc[srcAddress] ?? {}),
          [from]: fromPrev + e.value,
          [to]: toPrev - e.value,
        }
      }
    }, {} as CashflowRecord)

}

const getBaseToQuoteFn = ({ fillItem, collateralToken }: { fillItem: FillItemWithPricesFeesDebtAndCollateral; collateralToken: Token; }) => (amount: bigint) => mulDiv(amount, fillItem.referencePrice_long, collateralToken.unit)
const getQuoteToBaseFn = ({ fillItem, collateralToken }: { fillItem: FillItemWithPricesFeesDebtAndCollateral; collateralToken: Token; }) => (amount: bigint) => mulDiv(amount, collateralToken.unit, fillItem.referencePrice_long)

export const calculateCashflowsAndFee = ({ position, fillItem, debtToken, collateralToken, cashflows, feeEvent }: { feeEvent?: FeeCollectedEvent; position: Position; fillItem: FillItemWithPricesFeesDebtAndCollateral; debtToken: Token; collateralToken: Token; cashflows: CashflowRecord; }) => {
  const baseToQuote = getBaseToQuoteFn({ fillItem, collateralToken })
  const quoteToBase = getQuoteToBaseFn({ fillItem, collateralToken })


  let highestCashflowQuote = 0n
  let cashflowToken_id = debtToken.id
  let cashflow = 0n

  // because these two values are purely used for accounting, and we want to show realised pnl not accounting for our trading fees, we subtract the fees from the cashflows
  let cashflowQuote = -fillItem.fee_long
  let cashflowBase = -fillItem.fee_short

  Object.entries(cashflows).forEach(([tokenAddress, record]) => {
    Object.entries(record)
      .filter(([addressMovingMoney]) => {
        if ([ADDRESSES.vaultProxy, position.owner].includes(addressMovingMoney)) return true
        if (addressMovingMoney === zeroAddress && wrappedNativeMap[position.chainId] === tokenAddress) return true
        return false
      })
      .forEach(([_, value]) => {
        if (value === 0n) return
        const cashflowQuoteBefore = cashflowQuote
        if (tokenAddress === collateralToken.address) {
          cashflowBase += value
          cashflowQuote += baseToQuote(value)
        } else if (tokenAddress === debtToken.address) {
          cashflowQuote += value
          cashflowBase += quoteToBase(value)
        }

        const cashflowQuoteIncrease = cashflowQuote - cashflowQuoteBefore
        if (absolute(cashflowQuoteIncrease) > highestCashflowQuote) {
          // we assign the `cashflow` if it's the most valuable cashflow to the trader
          highestCashflowQuote = absolute(cashflowQuoteIncrease)
          cashflowToken_id = createTokenId({ address: tokenAddress, chainId: collateralToken.chainId })
          cashflow = value
        }
      })
    })
  
  if (fillItem.cashflowSwap) {
    const { cashflowSwap } = fillItem
    if (cashflowSwap.tokenOut_id === debtToken.id) {
      cashflowToken_id = cashflowSwap.tokenIn_id
      cashflow = cashflowSwap.amountIn
      cashflowQuote += cashflowSwap.amountOut
      cashflowBase += quoteToBase(cashflowSwap.amountOut)
    } else if (cashflowSwap.tokenOut_id === collateralToken.id) {
      cashflowToken_id = cashflowSwap.tokenIn_id
      cashflow = cashflowSwap.amountIn
      cashflowBase += cashflowSwap.amountOut
      cashflowQuote += baseToQuote(cashflowSwap.amountOut)
    } else if (cashflowSwap.tokenIn_id === debtToken.id) {
      cashflowToken_id = cashflowSwap.tokenOut_id
      cashflow = -cashflowSwap.amountOut
      cashflowQuote -= cashflowSwap.amountIn
      cashflowBase -= quoteToBase(cashflowSwap.amountIn)
    } else if (cashflowSwap.tokenIn_id === collateralToken.id) {
      cashflowToken_id = cashflowSwap.tokenOut_id
      cashflow = -cashflowSwap.amountOut
      cashflowBase -= cashflowSwap.amountIn
      cashflowQuote -= baseToQuote(cashflowSwap.amountIn)
    }
  }

  return { cashflow, cashflowQuote, cashflowBase, cashflowToken_id }
}
