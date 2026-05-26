import { handleRequest } from "../handler";

export default {
  fetch(request: Request) {
    return handleRequest(request);
  },
};
