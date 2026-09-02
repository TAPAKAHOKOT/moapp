import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const API_KEY = "moapp-demo-key";
const API_SECRET = "moapp-demo-secret";
const port = Number(process.env.BYBIT_MOCK_PORT ?? 4010);
let records: Array<Record<string, unknown>> | undefined;
let validationTime = 0;

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

function demoRecords(now: number): Array<Record<string, unknown>> {
  return [
    {
      tradeStatus: "1", status: "1", side: "3", transactionCurrencyAmount: "99.99", transactionCurrency: "EUR",
      txnCreate: now - 24 * 60 * 60 * 1000, merchName: "OLD PAYMENT — MUST BE HIDDEN", txnId: "demo-before-boundary", mccCode: "5999"
    },
    {
      tradeStatus: "1", status: "1", side: "3", transactionCurrencyAmount: "18.49", transactionCurrency: "EUR",
      txnCreate: now, merchName: "Green Market", merchCity: "Belgrade", merchCountry: "RS", txnId: "demo-grocery",
      orderNo: "demo-order-1", mccCode: "5411", merchCategoryDesc: "Grocery Stores"
    },
    {
      tradeStatus: "1", status: "1", side: "7", transactionCurrencyAmount: "7.20", transactionCurrency: "EUR",
      txnCreate: now, merchName: "Coffee Corner", merchCity: "Belgrade", merchCountry: "RS", txnId: "demo-coffee",
      orderNo: "demo-order-2", mccCode: "5814", merchCategoryDesc: "Fast Food Restaurants"
    },
    {
      tradeStatus: "1", status: "1", side: "13", transactionCurrencyAmount: "50.00", transactionCurrency: "EUR",
      txnCreate: now, merchName: "ATM Demo", merchCity: "Belgrade", merchCountry: "RS", txnId: "demo-atm",
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
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (request.method === "GET" && url.pathname === "/v5/user/query-api") {
    records = undefined;
    validationTime = Date.now();
    send(response, 200, { retCode: 0, retMsg: "OK", result: { readOnly: 1, permissions: { BitCard: ["BitCard"] } } });
    return;
  }
  if (request.method === "POST" && url.pathname === "/v5/card/transaction/query-asset-records") {
    let input: { limit?: unknown; page?: unknown };
    try { input = JSON.parse(body) as typeof input; }
    catch { send(response, 400, { retCode: 10001, retMsg: "Invalid JSON", result: {} }); return; }
    if (input.limit !== 500 || input.page !== 1) {
      send(response, 400, { retCode: 120110001, retMsg: "param_illegal", result: {} });
      return;
    }
    records ??= demoRecords(validationTime);
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
