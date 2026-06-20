import { Router } from "express";
import { authRouter } from "./auth-routes.js";
import { documentRouter } from "./document-routes.js";
import { categoryRouter } from "./category-routes.js";
import { tagRouter } from "./tag-routes.js";
import { searchRouter } from "./search-routes.js";
import { adminRouter } from "./admin-routes.js";
import {
  isOpenAiUsable,
  isVisionUsable,
} from "../env.js";
import { webSearchAvailable } from "../search/web-search-service.js";

export const apiRouter = Router();

// Veřejné info o dostupných funkcích (pro UI).
apiRouter.get("/capabilities", (_req, res) => {
  res.json({
    aiChat: isOpenAiUsable(),
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
