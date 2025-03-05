import { Token } from "generated";
import { mulDiv } from "../../utils/math-helpers";
import { FeeCollectedEvent, PositionUpsertedEvent } from "../../utils/types";
import { CashflowCurrency } from "../legacy";
import { FillItemWithPrices } from "./prices";

const getBaseToQuoteFn = ({ price_long, collateralToken }: { price_long: bigint; collateralToken: Token; }) => (amount: bigint) => mulDiv(amount, price_long, collateralToken.unit)
const getQuoteToBaseFn = ({ price_long, collateralToken }: { price_long: bigint; collateralToken: Token; }) => (amount: bigint) => mulDiv(amount, collateralToken.unit, price_long)


export const withFees = ({ fillItem, feeEvents, positionUpsertedEvents, collateralToken, debtToken }: { fillItem: FillItemWithPrices; feeEvents: FeeCollectedEvent[]; positionUpsertedEvents: PositionUpsertedEvent[]; collateralToken: Token; debtToken: Token }) => {
  const baseToQuote = getBaseToQuoteFn({ price_long: fillItem.referencePrice_long, collateralToken })
  const quoteToBase = getQuoteToBaseFn({ price_long: fillItem.referencePrice_long, collateralToken })

  let feeToken_id = debtToken.id
  let fee = 0n
  let fee_long = 0n
  let fee_short = 0n

  if (feeEvents.length > 0) {
    const feeEvent = feeEvents[0]
    feeToken_id = feeEvent.token_id
    fee = feeEvent.amount
  } else if (positionUpsertedEvents.length > 0) {
    // old fees (on position upserted events)
    const events = positionUpsertedEvents.filter(event => event.fee > 0n)
    if (events.length > 0) {
      // there should only be one position upserted event, but certainly only one with a fee
      const event = events[0]
      feeToken_id = Number(event.feeCcy) === CashflowCurrency.Base ? collateralToken.id : debtToken.id
      fee = event.fee
    }
  }

  if (feeToken_id === collateralToken.id) {
    fee_short += fee
    fee_long += baseToQuote(fee)
  } else if (feeToken_id === debtToken.id) {
    fee_long += fee
    fee_short += quoteToBase(fee)
  }

  return { ...fillItem, feeToken_id, fee, fee_long, fee_short }
}

export type FillItemWithPricesAndFees = Awaited<ReturnType<typeof withFees>>

