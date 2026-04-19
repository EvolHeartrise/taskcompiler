import { bootstrapTriggers } from "$lib/server/triggers/bootstrap";
import { wireHealer } from "$lib/server/healer";

bootstrapTriggers();
wireHealer();
