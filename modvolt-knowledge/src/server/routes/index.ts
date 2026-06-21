import { createRouter } from "../lib/async-router.js";
import { authRouter } from "./auth-routes.js";
import { documentRouter } from "./document-routes.js";
import { categoryRouter } from "./category-routes.js";
import { tagRouter } from "./tag-routes.js";
import { searchRouter } from "./search-routes.js";
import { adminRouter } from "./admin-routes.js";
import {
  isChatUsable,
  isVisionUsable,
} from "../env.js";
import { webSearchAvailable } from "../search/web-search-service.js";

export const apiRouter = createRouter();

// Veřejné info o dostupných funkcích (pro UI).
apiRouter.get("/capabilities", (_req, res) => {
  res.json({
    aiChat: isChatUsable(),
    vision: isVisionUsable(),
    webSearch: webSearchAvailable(),
  });
});

apiRouter.use("/auth", authRouter);
apiRouter.use("/documents", documentRouter);
apiRouter.use("/categories", categoryRouter);
apiRouter.use("/tags", tagRouter);
apiRouter.use("/", searchRouter);
apiRouter.use("/admin", adminRouter);
