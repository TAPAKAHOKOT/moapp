import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const API_KEY = "moapp-demo-key";
const API_SECRET = "moapp-demo-secret";
const port = Number(process.env.BYBIT_MOCK_PORT ?? 4010);
let records: Array<Record<string, unknown>> | undefined;

function send(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
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

function demoRecords(boundary: number, upper: number): Array<Record<string, unknown>> {
  const at = (offset: number) => Math.min(boundary + offset, upper);
  return [
    {
      tradeStatus: "1", status: "1", side: "3", transactionCurrencyAmount: "99.99", transactionCurrency: "EUR",
      txnCreate: boundary - 1, merchName: "OLD PAYMENT — MUST BE HIDDEN", txnId: "demo-before-boundary", mccCode: "5999"
    },
    {
      tradeStatus: "1", status: "1", side: "3", transactionCurrencyAmount: "18.49", transactionCurrency: "EUR",
      txnCreate: at(0), merchName: "Green Market", merchCity: "Belgrade", merchCountry: "RS", txnId: "demo-grocery",
      orderNo: "demo-order-1", mccCode: "5411", merchCategoryDesc: "Grocery Stores"
    },
    {
      tradeStatus: "1", status: "1", side: "7", transactionCurrencyAmount: "7.20", transactionCurrency: "EUR",
      txnCreate: at(1), merchName: "Coffee Corner", merchCity: "Belgrade", merchCountry: "RS", txnId: "demo-coffee",
      orderNo: "demo-order-2", mccCode: "5814", merchCategoryDesc: "Fast Food Restaurants"
    },
    {
      tradeStatus: "1", status: "1", side: "13", transactionCurrencyAmount: "50.00", transactionCurrency: "EUR",
      txnCreate: at(2), merchName: "ATM Demo", merchCity: "Belgrade", merchCountry: "RS", txnId: "demo-atm",
      orderNo: "demo-order-3", mccCode: "6011", merchCategoryDesc: "ATM Withdrawal"
    }
  ];
}

const server = createServer(async (request, response) => {
  const body = await bodyOf(request);
  if (!authorized(request, body)) {
    send(response, 401, { retCode: 10003, retMsg: "Invalid demo API key or signature", result: {} });
    return;
  }
  if (request.method === "GET" && request.url === "/v5/user/query-api") {
    records = undefined;
    send(response, 200, { retCode: 0, retMsg: "OK", result: { readOnly: 1, permissions: { BitCard: ["BitCard"] } } });
    return;
  }
  if (request.method === "POST" && request.url === "/v5/card/transaction/query-asset-records") {
    let input: { createBeginTime?: unknown; createEndTime?: unknown };
    try { input = JSON.parse(body) as typeof input; }
    catch { send(response, 400, { retCode: 10001, retMsg: "Invalid JSON", result: {} }); return; }
    const boundary = Number(input.createBeginTime);
    const upper = Number(input.createEndTime);
    if (!Number.isFinite(boundary) || !Number.isFinite(upper)) {
      send(response, 400, { retCode: 10001, retMsg: "Missing sync boundary", result: {} });
      return;
    }
    records ??= demoRecords(boundary, upper);
    send(response, 200, { retCode: 0, retMsg: "OK", result: { pageSize: records.length, totalCount: records.length, data: records } });
    return;
  }
  send(response, 404, { retCode: 10001, retMsg: "Unknown mock endpoint", result: {} });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Mock Bybit Card API: http://127.0.0.1:${port}`);
  console.log(`API key: ${API_KEY}`);
  console.log(`API secret: ${API_SECRET}`);
});
