// Vercel's serverless entry point — every request (routed here by server/vercel.json's catch-all
// rewrite) hits this one function, and Express's own internal routers (mounted in app.ts) handle
// the actual dispatching from there, exactly as they do locally. No .env loading here, unlike
// index.ts's dev entry: Vercel injects real environment variables into process.env directly from
// the project's dashboard settings, there's no .env file to find on a deployed function.
import { app } from '../src/app.ts'

export default app
