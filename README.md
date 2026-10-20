# Transaction Webhook Ingestion & Background Processing Service

A serverless transaction webhook ingestion service built using **Supabase Edge Functions (Deno / TypeScript)** and **Supabase PostgreSQL**, developed for the **Backend Development Assessment** (Walnut Folks / Confluencr).

The service receives transaction webhooks from payment processors (e.g. Razorpay), acknowledges them immediately with **HTTP 202 Accepted**, enforces **strict idempotency**, and executes background processing with a **30-second delay** backed by persistent database storage.

---

## 🌐 Public Live Cloud API Endpoint

* **Base URL:** `https://oehnlycyvucimchrtivh.supabase.co/functions/v1/api`
* **Health Check:** `GET https://oehnlycyvucimchrtivh.supabase.co/functions/v1/api`
* **Webhook Endpoint:** `POST https://oehnlycyvucimchrtivh.supabase.co/functions/v1/api/v1/webhooks/transactions`
* **Query Endpoint:** `GET https://oehnlycyvucimchrtivh.supabase.co/functions/v1/api/v1/transactions/{transaction_id}`

---

## 🛠 Architecture & Technical Choices

### 1. Supabase Edge Functions (`supabase/functions/api/index.ts`)
* **Zero Server Overhead:** Deployed directly onto Supabase Edge infrastructure (Deno V8 runtime) close to users worldwide.
* **Immediate Response:** Acknowledges incoming transaction webhooks within `< 500ms`.
* **Reliable 30s Background Delay:** Utilizes `EdgeRuntime.waitUntil(...)` to run the 30-second background processing task asynchronously without keeping the HTTP connection open.

### 2. Supabase PostgreSQL Persistence & Idempotency
* `transaction_id` is set as the `PRIMARY KEY`.
* **Idempotency Guarantee:** If a duplicate webhook with the same `transaction_id` is received, the service detects the conflict (PostgreSQL constraint `23505`) and safely returns `202 Accepted` with `"Transaction already received"`, avoiding any duplicate processing.

---

## 🚀 API Endpoints Specification

### 1. Health Check
* **Method:** `GET`
* **Path:** `/` or `/api`
* **Response Status:** `200 OK`
```json
{
  "status": "HEALTHY",
  "current_time": "2026-10-20T06:25:48.641Z"
}
```

---

### 2. Webhook Ingestion
* **Method:** `POST`
* **Path:** `/v1/webhooks/transactions`
* **Response Status:** `202 Accepted`
* **Request Body:**
```json
{
  "transaction_id": "txn_abc123def456",
  "source_account": "acc_user_789",
  "destination_account": "acc_merchant_456",
  "amount": 1500,
  "currency": "INR"
}
```
* **Response Body:**
```json
{
  "status": "ACCEPTED",
  "message": "Transaction webhook received"
}
```

---

### 3. Query Transaction Status
* **Method:** `GET`
* **Path:** `/v1/transactions/{transaction_id}`

* **Initial Response (during the 30s background window):**
```json
{
  "transaction_id": "txn_abc123def456",
  "source_account": "acc_user_789",
  "destination_account": "acc_merchant_456",
  "amount": 1500,
  "currency": "INR",
  "status": "PROCESSING",
  "created_at": "2026-10-20T06:25:49.704Z",
  "processed_at": null
}
```

* **Final Response (after 30 seconds):**
```json
{
  "transaction_id": "txn_abc123def456",
  "source_account": "acc_user_789",
  "destination_account": "acc_merchant_456",
  "amount": 1500,
  "currency": "INR",
  "status": "PROCESSED",
  "created_at": "2026-10-20T06:25:49.704Z",
  "processed_at": "2026-10-20T06:26:20.501Z"
}
```

---

## 🗄 Database Schema (Supabase)

```sql
CREATE TABLE IF NOT EXISTS transactions (
    transaction_id VARCHAR(255) PRIMARY KEY,
    source_account VARCHAR(255) NOT NULL,
    destination_account VARCHAR(255) NOT NULL,
    amount NUMERIC(15, 2) NOT NULL,
    currency VARCHAR(10) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'PROCESSING',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ DEFAULT NULL
);

-- Row Level Security (RLS) Configuration
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow service role full access" 
ON public.transactions 
FOR ALL 
TO service_role 
USING (true) 
WITH CHECK (true);
```


---

## 🧪 How to Test

### 1. Automated Test Script
Run the automated test suite directly against the live Supabase Edge Function:
```bash
npm test
```

### 2. Manual Testing with cURL

#### Step 1: Health Check
```bash
curl https://oehnlycyvucimchrtivh.supabase.co/functions/v1/api
```

#### Step 2: Ingest Webhook
```bash
curl -i -X POST https://oehnlycyvucimchrtivh.supabase.co/functions/v1/api/v1/webhooks/transactions \
  -H "Content-Type: application/json" \
  -d '{
    "transaction_id": "txn_sample_123",
    "source_account": "acc_user_789",
    "destination_account": "acc_merchant_456",
    "amount": 1500,
    "currency": "INR"
  }'
```

#### Step 3: Check Immediate Status
```bash
curl https://oehnlycyvucimchrtivh.supabase.co/functions/v1/api/v1/transactions/txn_sample_123
```

#### Step 4: Check Status after 30 seconds
```bash
curl https://oehnlycyvucimchrtivh.supabase.co/functions/v1/api/v1/transactions/txn_sample_123
```
