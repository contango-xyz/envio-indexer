import { Token, handlerContext } from 'generated';
import { erc20Abi, erc20Abi_bytes32, hexToString } from 'viem';
import { clients } from '../clients';
import { Cache, CacheCategory } from './cache';
import { symbolToDisplaySymbol } from './displaySymbols';

export function getERC20Contract(address: string) {
    return { address: address as `0x${string}`, abi: erc20Abi };
}

export function getERC20BytesContract(address: string) {
    return {
        address: address as `0x${string}`,
        abi: erc20Abi_bytes32,
    };
}

export const createTokenId = ({ chainId, address }: { chainId: number; address: string; }) => `${chainId}_${address.toLowerCase()}`

export const decodeTokenId = (tokenId: string) => {
  const [chainId, address] = tokenId.split('_')
  return { chainId: parseInt(chainId), address: address.toLowerCase() }
}

const saveTokenIfDisplaySymbolHasChanged = (token: Token, context: handlerContext) => {
  const displaySymbol = symbolToDisplaySymbol({ address: token.address, symbol: token.symbol, chainId: token.chainId })
  if (displaySymbol !== token.displaySymbol) {
    context.Token.set({ ...token, displaySymbol })
  }
  return token
}

const getTokenDetails = async (address: string, chainId: number) => {
  const cache = Cache.init({ category: CacheCategory.Token, chainId });
  const token = cache.read(address);

  if (token) return token

  const client = clients[chainId]

  const erc20 = getERC20Contract(address);
  const erc20Bytes = getERC20BytesContract(address);

  let results: [number, string, string];
  try {
    results = await client.multicall({
      allowFailure: false,
      contracts: [
        {
          ...erc20,
          functionName: "decimals",
        },
        {
          ...erc20,
          functionName: "name",
        },
        {
          ...erc20,
          functionName: "symbol",
        },
      ],
    });
  } catch (error) {
    console.log("First multicall failed, trying alternate method");
    try {
      const alternateResults = await client.multicall({
        allowFailure: false,
        contracts: [
          {
            ...erc20Bytes,
            functionName: "decimals",
          },
          {
            ...erc20Bytes,
            functionName: "name",
          },
          {
            ...erc20Bytes,
            functionName: "symbol",
          },
        ],
      });
      results = [
        alternateResults[0],
        hexToString(alternateResults[1]).replace(/\u0000/g, ''),
        hexToString(alternateResults[2]).replace(/\u0000/g, ''),
      ];
    } catch (alternateError) {
      console.error(`Alternate method failed for token ${address}:`);
      results = [0,"unknown","unknown"];
    }
  }

  const [decimals, name, symbol] = results;
  
  console.log(`Got token details for ${address}: ${name} (${symbol}) with ${decimals} decimals`);

  const entry: Token = {
    id: createTokenId({ chainId, address: address }),
    address,
    chainId,
    unit: 10n ** BigInt(decimals),
    decimals,
    symbol,
    displaySymbol: symbolToDisplaySymbol({ address, symbol, chainId }),
  };

  // add to cache 
  cache.add({ [address]: entry });

  return entry
}

export async function getOrCreateToken(
  { address: _address, chainId, context }: { address: string; chainId: number; context: handlerContext; }
): Promise<Token> {
  const address = _address.toLowerCase()

  // second check db
  const storedToken = await context.Token.get(createTokenId({ chainId, address: address }));
  if (storedToken) {
    // add to cache for next time
    return saveTokenIfDisplaySymbolHasChanged(storedToken, context)
  }

  const token = await getTokenDetails(address, chainId)

  // save to db
  context.Token.set(token)

  return token;
}

export const getTokenOrThrow = async ({ id, context }: { id: string; context: handlerContext; }) => {
  const token = await context.Token.get(id)
  if (!token) throw new Error(`Token ${id} not found`)
  return token
}
