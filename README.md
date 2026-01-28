# ZenFinance Backend

A lightweight Node.js/Express server that acts as an OAuth 2.0 gateway for the ZenFinance Tracker application.

## 🔒 Purpose

This backend is specifically designed to handle the **Authorization Code Flow** for Google OAuth.

- It exchanges the one-time `auth-code` from the frontend for persistent `access_tokens` and `refresh_tokens`.
- It handles token refreshing, ensuring users stay logged in without repeated prompts.
- It protects your `GOOGLE_CLIENT_SECRET` by keeping it on the server side.

## 🚀 Getting Started

### Prerequisites

- Node.js (Latest LTS)
- A Google Cloud Project with OAuth 2.0 credentials (Web Client).

### Installation

1. **Navigate to the backend directory**

   ```bash
   cd finance-tracker-app-backend
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Environment Setup**
   Create a `.env` file from the example:

   ```bash
   cp .env.example .env
   ```

   Fill in your credentials:

   ```env
   PORT=3001
   GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your_client_secret
   ```

4. **Run the server**
   ```bash
   node index.js
   ```

## 🛠️ Tech Stack

- **Framework**: Express.js
- **Auth**: Google-auth-library
- **Security**: CORS, Dotenv

## 📡 Endpoints

### `POST /auth/google`

Exchanges an authorization code for tokens.

- **Body**: `{ "code": "..." }`
- **Returns**: Access and Refresh tokens.

### `POST /auth/refresh`

Refreshes an expired access token.

- **Body**: `{ "refresh_token": "..." }`
- **Returns**: A new access token.
