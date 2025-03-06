import { Token } from "generated";
import { zeroAddress } from "viem";
import { ADDRESSES, wrappedNativeMap } from "../../utils/constants";
import { createTokenId } from "../../utils/getTokenDetails";
import { absolute, mulDiv } from "../../utils/math-helpers";
import { TransferEvent } from "../../utils/types";
import { PriceConverters, ReferencePrices } from "./prices";

type Params = {
  owner: string
  chainId: number
  debtToken: Token
  collateralToken: Token
  transferEvents: TransferEvent[]
  prices: ReferencePrices
  fee_long: bigint
  fee_short: bigint
  converters: PriceConverters
}

export const withCashflows = ({ owner, chainId, debtToken, collateralToken, transferEvents, prices, fee_long, fee_short, converters }: Params) => {
  const cashflows = calculateNetCashflows(transferEvents)
  const { baseToQuote, quoteToBase } = converters

  let highestCashflowQuote = 0n
  let cashflowToken_id = undefined
  let cashflow = 0n

  // because these two values are purely used for accounting, and we want to show realised pnl not accounting for our trading fees, we subtract the fees from the cashflows
  let cashflowQuote = -fee_long
  let cashflowBase = -fee_short

  Object.entries(cashflows).forEach(([tokenAddress, record]) => {
    Object.entries(record)
      .filter(([addressMovingMoney]) => {
        if ([ADDRESSES.vaultProxy, owner].includes(addressMovingMoney)) return true
        if (addressMovingMoney === zeroAddress && wrappedNativeMap[chainId] === tokenAddress) return true
        return false
      })
      .forEach(([addressMovingMoney, value]) => {
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
  
  if (prices.cashflowSwap) {
    const { cashflowSwap } = prices
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

type AddressHoldingFunds = string
type TokenAddress = string
type CashflowRecordInner = Record<TokenAddress, bigint>
type CashflowRecord = Record<AddressHoldingFunds, CashflowRecordInner>

export const calculateNetCashflows = (events: TransferEvent[]): CashflowRecord => {
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
