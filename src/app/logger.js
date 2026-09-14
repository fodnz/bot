import { createPinoLogger } from "zapo-js";

export const logger = await createPinoLogger({
    level: "info",
    pretty: true
});
