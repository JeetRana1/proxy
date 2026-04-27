import { handleRequest } from "../handler";

export const config = {
  runtime: "edge",
};

export default function (req: Request) {
  return handleRequest(req);
}
