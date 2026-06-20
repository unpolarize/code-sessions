import type { Signal, Turn } from '@unpolarize/code-sessions-schema';
import { deriveTags, guessTopic } from './heuristics';

export interface LabelRequest {
  sessionId: string;
  host: string;
  turns: Turn[];
}

export interface LabelResult {
  topic?: string;
  tags: string[];
  signals: Signal[];
  summary?: string;
}

/** An insights provider turns a session into topic/tags/summary (+ optional signals). */
export interface Provider {
  readonly name: string;
  label(req: LabelRequest): Promise<LabelResult>;
}

/** No-LLM provider: deterministic topic/tags from the transcript. Always available. */
export class FakeProvider implements Provider {
  readonly name = 'fake';
  async label(req: LabelRequest): Promise<LabelResult> {
    const result: LabelResult = {
      tags: deriveTags(req.turns),
      signals: [],
    };
    const topic = guessTopic(req.turns);
    if (topic) result.topic = topic;
    const assistantText = req.turns.find((t) => t.role === 'assistant')?.text;
    if (assistantText) result.summary = assistantText.slice(0, 160);
    return result;
  }
}
