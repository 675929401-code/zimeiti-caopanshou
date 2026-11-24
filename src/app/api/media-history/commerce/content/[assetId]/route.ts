export const dynamic = "force-dynamic";

function retired() {
  return Response.json({error: "请在带货创作的资产库中管理作品。"}, {status: 410, headers: {"Cache-Control": "no-store"}});
}

export const GET = retired;
export const HEAD = retired;
