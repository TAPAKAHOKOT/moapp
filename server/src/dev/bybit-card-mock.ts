import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/*
 * Mirrors the behaviour observed on api.bybit.com (2026-09-03) rather than the published
 * documentation: asset-record parameters live in the JSON body, only SIDE_QUERY_AUTH is accepted,
 * `limit` above 100 falls back to a page of 10, every payment is side 1, and the endpoint allows
 * one request per second.
 */
const API_KEY = "moapp-demo-key";
const API_SECRET = "moapp-demo-secret";
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 10;
const RATE_LIMIT_WINDOW_MS = 1000;
const port = Number(process.env.BYBIT_MOCK_PORT ?? 4010);
let records: Array<Record<string, unknown>> | undefined;
let validationTime = 0;
let lastAssetRequestAt = 0;

function send(response: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(payload));
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function authorized(request: IncomingMessage, body: string): boolean {
  const key = request.headers["x-bapi-api-key"];
  const timestamp = request.headers["x-bapi-timestamp"];
  const receiveWindow = request.headers["x-bapi-recv-window"];
  const signature = request.headers["x-bapi-sign"];
  if (key !== API_KEY || typeof timestamp !== "string" || typeof receiveWindow !== "string" || typeof signature !== "string") return false;
  const payload = `${timestamp}${key}${receiveWindow}${request.method === "POST" ? body : ""}`;
  return createHmac("sha256", API_SECRET).update(payload).digest("hex") === signature;
}

function payment(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    pan4: "4242", tradeStatus: "1", status: "1", side: "1", declinedReason: "0",
    basicCurrency: "USD", transactionCurrency: "USD", paidCurrency: "RSD", totalFees: "0.17000000",
    ...overrides
  };
}

function demoRecords(now: number): Array<Record<string, unknown>> {
  return [
    payment({
      basicAmount: "101.500000000000000000", transactionAmount: "99.990000000000000000", transactionCurrencyAmount: "101.5000000000",
      paidAmount: "9990.000000000000000000", txnCreate: String(now - 24 * 60 * 60 * 1000),
      merchName: "OLD PAYMENT — MUST BE HIDDEN", merchCountry: "SRB", txnId: "demo-before-boundary", mccCode: "5999"
    }),
    payment({
      basicAmount: "18.490000000000000000", transactionAmount: "18.120000000000000000", transactionCurrencyAmount: "18.4900000000",
      paidAmount: "1849.000000000000000000", txnCreate: String(now), merchName: "Green Market", merchCity: "Belgrade", merchCountry: "SRB",
      txnId: "demo-grocery", orderNo: "demo-order-1", mccCode: "5411", merchCategoryDesc: "Grocery Stores"
    }),
    payment({
      basicAmount: "7.200000000000000000", transactionAmount: "7.060000000000000000", transactionCurrencyAmount: "7.2000000000",
      paidAmount: "720.000000000000000000", txnCreate: String(now), merchName: "Coffee Corner", merchCity: "Belgrade", merchCountry: "SRB",
      txnId: "demo-coffee", orderNo: "demo-order-2", mccCode: "5814", merchCategoryDesc: "Fast Food Restaurants"
    }),
    payment({
      basicAmount: "50.000000000000000000", transactionAmount: "49.000000000000000000", transactionCurrencyAmount: "50.0000000000",
      paidAmount: "5000.000000000000000000", txnCreate: String(now), merchName: "ATM Demo", merchCity: "Belgrade", merchCountry: "SRB",
      txnId: "demo-atm", orderNo: "demo-order-3", mccCode: "6011", merchCategoryDesc: "ATM Withdrawal"
    }),
    payment({
      tradeStatus: "0", basicAmount: "12.000000000000000000", transactionAmount: "11.760000000000000000", transactionCurrencyAmount: "12.0000000000",
      paidAmount: "1200.000000000000000000", txnCreate: String(now), merchName: "Pending Authorization", merchCity: "Belgrade", merchCountry: "SRB",
      txnId: "demo-pending", orderNo: "demo-order-4", mccCode: "5999", merchCategoryDesc: "Miscellaneous Retail"
    }),
    payment({
      tradeStatus: "2", status: "2", declinedReason: "51", basicAmount: "3.000000000000000000", transactionAmount: "2.940000000000000000",
      transactionCurrencyAmount: "3.0000000000", paidAmount: "300.000000000000000000", txnCreate: String(now),
      merchName: "DECLINED — MUST BE HIDDEN", merchCountry: "SRB", txnId: "demo-declined", mccCode: "5999"
    })
  ];
}

function parseBody(body: string): Record<string, unknown> | null {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function integer(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

const server = createServer(async (request, response) => {
  const body = await bodyOf(request);
  if (!authorized(request, body)) {
    send(response, 401, { retCode: 10003, retMsg: "API key is invalid.", result: {} });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (request.method === "GET" && url.pathname === "/v5/user/query-api") {
    records = undefined;
    validationTime = Date.now();
    send(response, 200, {
      retCode: 0, retMsg: "",
      result: { readOnly: 1, type: 1, isMaster: true, ips: ["*"], deadlineDay: 90, permissions: { BitCard: ["BitCard"] } }
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/v5/card/transaction/query-asset-records") {
    const now = Date.now();
    if (now - lastAssetRequestAt < RATE_LIMIT_WINDOW_MS) {
      send(response, 200, { retCode: 10006, retMsg: "Too many visits. Exceeded the API Rate Limit.", result: {} }, {
        "x-bapi-limit": "1", "x-bapi-limit-status": "0", "x-bapi-limit-reset-timestamp": String(lastAssetRequestAt + RATE_LIMIT_WINDOW_MS)
      });
      return;
    }
    lastAssetRequestAt = now;
    const params = parseBody(body);
    const page = integer(params?.page) ?? 1;
    const requestedLimit = integer(params?.limit) ?? DEFAULT_PAGE_SIZE;
    const begin = integer(params?.createBeginTime);
    const end = integer(params?.createEndTime);
    if (!params || params.type !== "SIDE_QUERY_AUTH" || page < 1 || requestedLimit < 1 || url.search) {
      send(response, 200, { retCode: 120110001, retMsg: "param_illegal", result: {} });
      return;
    }
    const pageSize = requestedLimit > MAX_PAGE_SIZE ? DEFAULT_PAGE_SIZE : requestedLimit;
    records ??= demoRecords(validationTime);
    const matching = records.filter((record) => {
      const created = Number(record.txnCreate);
      return (begin === null || created >= begin) && (end === null || created <= end);
    });
    const data = matching.slice((page - 1) * pageSize, page * pageSize);
    send(response, 200, {
      retCode: 0, retMsg: "success",
      result: { pageSize, pageNo: page, totalCount: matching.length, data }
    }, { "x-bapi-limit": "1", "x-bapi-limit-status": "0", "x-bapi-limit-reset-timestamp": String(now + RATE_LIMIT_WINDOW_MS) });
    return;
  }
  send(response, 404, { retCode: 10017, retMsg: "Route not found.", result: {} });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Mock Bybit Card API: http://127.0.0.1:${port}`);
  console.log(`API key: ${API_KEY}`);
  console.log(`API secret: ${API_SECRET}`);
});
