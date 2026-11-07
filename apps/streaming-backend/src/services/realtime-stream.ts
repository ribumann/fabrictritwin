import type { RaceSplit, SessionMetric } from "@triathlon-twin/simulator";
import type { ActiveAlert } from "./realtime-insights.js";

export interface AlertFrame {
  type: "alert";
  alert: ActiveAlert;
}

export interface MetricFrame {
  type: "metric";
  sessionId: string;
  metric: SessionMetric;
}

export interface RaceSplitFrame {
  type: "raceSplit";
  raceId: string;
  split: RaceSplit;
}

export interface SessionStatusFrame {
  type: "sessionStatus";
  sessionId: string;
  status: "completed" | "missed";
}

export type StreamFrame = AlertFrame | MetricFrame | RaceSplitFrame | SessionStatusFrame;

export interface RealtimeStreamEvent {
  athleteId: string;
  frame: StreamFrame;
}

type Subscriber = (event: RealtimeStreamEvent) => void;

export class RealtimeStreamBroker {
  private readonly subscribers = new Set<Subscriber>();

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  publish(event: RealtimeStreamEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  publishMetric(athleteId: string, sessionId: string, metric: SessionMetric): void {
    this.publish({
      athleteId,
      frame: {
        type: "metric",
        sessionId,
        metric,
      },
    });
  }

  publishRaceSplit(athleteId: string, raceId: string, split: RaceSplit): void {
    this.publish({
      athleteId,
      frame: {
        type: "raceSplit",
        raceId,
        split,
      },
    });
  }

  publishSessionStatus(athleteId: string, sessionId: string, status: "completed" | "missed"): void {
    this.publish({
      athleteId,
      frame: {
        type: "sessionStatus",
        sessionId,
        status,
      },
    });
  }

  publishAlert(athleteId: string, alert: ActiveAlert): void {
    this.publish({
      athleteId,
      frame: {
        type: "alert",
        alert,
      },
    });
  }

  resetForTests(): void {
    this.subscribers.clear();
  }
}

export const realtimeStreamBroker = new RealtimeStreamBroker();
