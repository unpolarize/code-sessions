import { zodToJsonSchema } from 'zod-to-json-schema';
import { InsightsSchema, SessionSchema, TurnSchema } from './schemas';

/** JSON Schema (draft-07) representations for external (non-TS) consumers. */
export const turnJsonSchema = zodToJsonSchema(TurnSchema, 'Turn');
export const sessionJsonSchema = zodToJsonSchema(SessionSchema, 'Session');
export const insightsJsonSchema = zodToJsonSchema(InsightsSchema, 'Insights');

/** Parse + validate (throws on invalid). Applies schema defaults. */
export const parseTurn = (data: unknown) => TurnSchema.parse(data);
export const parseSession = (data: unknown) => SessionSchema.parse(data);
export const parseInsights = (data: unknown) => InsightsSchema.parse(data);

/** Non-throwing validation. */
export const safeParseTurn = (data: unknown) => TurnSchema.safeParse(data);
export const safeParseSession = (data: unknown) => SessionSchema.safeParse(data);
export const safeParseInsights = (data: unknown) => InsightsSchema.safeParse(data);
