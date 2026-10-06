import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

type AssetFixture = {
  id: string;
  owner: string;
  name: string;
  type: string;
  size: number;
  sha256: string;
  createdAt: number;
  source: 'upload' | 'generated';
  providerReferenceUrl?: string;
};

function loadRoute(file: string, modules: Record<string, unknown>) {
  const source = fs.readFileSync(file, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const evaluatedModule = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(output, {
    module: evaluatedModule,
    exports: evaluatedModule.exports,
    Buffer,
    File,
    FormData,
    Request,
    Response,
    require(id: string) {
      assert.ok(Object.hasOwn(modules, id), `unexpected module: ${id}`);
      return modules[id];
    },
  });
  return evaluatedModule.exports as {
    GET(request: Request): Promise<Response>;
    POST(request: Request): Promise<Response>;
  };
}

async function main() {
  const listed: AssetFixture = {
    id: 'asset-listed',
    owner: 'owner-a',
    name: '生成图.png',
    type: 'image/png',
    size: 128,
    sha256: 'a'.repeat(64),
    createdAt: 1,
    source: 'generated',
    providerReferenceUrl: 'https://provider.invalid/private-reference',
  };
  const uploaded: AssetFixture = {
    id: 'asset-uploaded',
    owner: 'owner-a',
    name: '商品图.png',
    type: 'image/png',
    size: 8,
    sha256: 'b'.repeat(64),
    createdAt: 2,
    source: 'upload',
  };
  const calls = {
    identities: 0,
    accountAuthorizations: 0,
    origins: 0,
    lists: [] as string[],
    uploads: [] as Array<{ owner: string; type: string; name: string; bytes: number }>,
  };

  const route = loadRoute('src/app/api/commerce/assets/route.ts', {
    '../../../../commerce/server/auth': {
      requireIdentity() {
        calls.identities += 1;
        return { id: 'owner-a' };
      },
      sameOrigin() {
        calls.origins += 1;
      },
    },
    '../../../../commerce/server/main-account-access': {
      async authorizeCurrentCommerceIdentity(identity: { id: string }) {
        assert.equal(identity.id, 'owner-a');
        calls.accountAuthorizations += 1;
      },
    },
    '../../../../commerce/server/assets': {
      assets(owner: string) {
        calls.lists.push(owner);
        return [listed];
      },
      async storeAsset(owner: string, bytes: Buffer, type: string, name: string) {
        calls.uploads.push({ owner, type, name, bytes: bytes.length });
        return uploaded;
      },
      publicAsset(asset: AssetFixture) {
        return {id:asset.id,name:asset.name,type:asset.type,size:asset.size,sha256:asset.sha256,createdAt:asset.createdAt,source:asset.source,url:`/api/commerce/assets/${asset.id}`};
      },
      readAsset() {
        return undefined;
      },
    },
    '../../../../commerce/server/store': { remove() {} },
    '../../../../commerce/server/http': {
      json: (body: unknown, status = 200) => Response.json(body, { status }),
      errorResponse: (error: unknown) => Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      ),
    },
  });

  const getResponse = await route.GET(new Request('http://local.invalid/api/commerce/assets'));
  assert.equal(getResponse.status, 200);
  const getPayload = await getResponse.json() as { assets: Array<Record<string, unknown>> };
  assert.equal(getPayload.assets.length, 1);
  assert.equal(getPayload.assets[0].url, '/api/commerce/assets/asset-listed');
  assert.equal('owner' in getPayload.assets[0], false);
  assert.equal('providerReferenceUrl' in getPayload.assets[0], false);
  assert.equal('providerReferenceKey' in getPayload.assets[0], false);
  assert.equal('providerReferenceProvider' in getPayload.assets[0], false);
  assert.equal('temporary' in getPayload.assets[0], false);
  assert.equal('idempotencyKey' in getPayload.assets[0], false);
  assert.deepEqual(calls.lists, ['owner-a']);

  const form = new FormData();
  form.set('file', new File([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])], '商品图.png', { type: 'image/png' }));
  const postResponse = await route.POST(new Request('http://local.invalid/api/commerce/assets', {
    method: 'POST',
    headers: { Origin: 'http://local.invalid' },
    body: form,
  }));
  assert.equal(postResponse.status, 200);
  const postPayload = await postResponse.json() as { asset: Record<string, unknown> };
  assert.equal(postPayload.asset.url, '/api/commerce/assets/asset-uploaded');
  assert.equal('owner' in postPayload.asset, false);
  assert.deepEqual(calls.uploads, [{ owner: 'owner-a', type: 'image/png', name: '商品图.png', bytes: 8 }]);
  assert.equal(calls.origins, 1);
  assert.equal(calls.identities, 2);
  assert.equal(calls.accountAuthorizations, 2);

  const source = fs.readFileSync('src/app/api/commerce/assets/route.ts', 'utf8');
  assert.equal(source.includes('`/api/assets/${'), false, 'legacy non-existent asset route must not return');
  const delivery = fs.readFileSync('src/app/api/commerce/assets/[id]/route.ts', 'utf8');
  assert.match(delivery, /readAsset\(id,user\.id\)/u, 'delivery route must remain owner scoped');
  assert.match(delivery, /assetBytes\(asset\)/u, 'delivery route must read the persisted commerce asset');

  console.log(JSON.stringify({
    passed: 18,
    listUrl: getPayload.assets[0].url,
    uploadUrl: postPayload.asset.url,
    ownerScoped: true,
    currentMainAccountBound: true,
    privateProviderUrlHidden: true,
    providerRequests: 0,
    walletWrites: 0,
    realDatabaseWrites: 0,
  }));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
