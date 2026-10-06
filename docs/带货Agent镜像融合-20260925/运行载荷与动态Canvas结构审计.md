# 运行载荷与动态 Canvas 结构审计

生成时间：2026-09-25T07:05:38.415Z

Authorized saved GET response bodies and dynamic Canvas browser controller only. Values that could contain account IDs, prompts, user assets or generated content are excluded; the report retains field paths, types, counts, safe status enums and hashes.

固定点：observable-readonly-payload-and-dynamic-controller-closure-passed（12/12）

## 核对项

- 通过｜agent conversation list
- 通过｜image-generation filtered batches
- 通过｜ecommerce-image-set filtered batches
- 通过｜at least two saved batch details
- 通过｜canvas list
- 通过｜canvas detail
- 通过｜current operation notice
- 通过｜recharge package list
- 通过｜usage ledger
- 通过｜usage summary
- 通过｜dynamic canvas document
- 通过｜dynamic canvas page chunk

## 动态 Canvas

- node and edge graph editor
- grouping and minimap/zoom controls
- drag/drop media nodes
- slash skill and mention affordances
- share-link client contract
- multi-track clip editor integration
- 边界：Canvas-only skill submission was not executed because it would create business state and can create paid media tasks.

## 已保存响应结构

- /api/v1/affiliate/me｜51 bytes｜字段 3｜数组 0｜SHA256 296fa71dcdaac415c680f227355ce2e6e5debbf06f734d6ea00db3fc0b93c168
- /api/v1/agent/conversations?limit=30&source=home｜1345 bytes｜字段 13｜数组 1｜SHA256 72e31aa32011fbd76b63443886be37aa7bd4cf0e2c188a00282729aa2baec926
- /api/v1/auth/me｜343 bytes｜字段 13｜数组 1｜SHA256 df2f08b66ae35fe6693c19584a6f4ce64d3d83fd2115680d147e7d998a99a76b
- /api/v1/batches?limit=15&tool_slug=image-generation｜12181 bytes｜字段 21｜数组 2｜SHA256 a0f7d6d2a2e5d02ce5031c909b4ebfd869e4454b0f233b89283a52e0f559c086
- /api/v1/batches?limit=20&tool_slug=ecommerce-image-set｜913 bytes｜字段 21｜数组 2｜SHA256 21c0f39a5430c20969b86070c90f1b39dfb87cb6ce085437f72964b012592655
- /api/v1/batches?sha256=%7Bvalue%7D｜41 bytes｜字段 3｜数组 1｜SHA256 0ba0a19264d99ae5d49caa5cb1ee737799cba962afb923c602f96120df6f6813
- /api/v1/batches?sha256=%7Bvalue%7D｜4419 bytes｜字段 21｜数组 2｜SHA256 8d2f143f99d6d7feaa82390750844f989487dedf683bf0c69f979857d2b5eebf
- /api/v1/batches/{id}｜49510 bytes｜字段 376｜数组 30｜SHA256 47ab032c5d7ab398cf9c705f5808a71b2d166b660caded087fcbdbffa0a4e61f
- /api/v1/batches/{id}｜6934 bytes｜字段 137｜数组 17｜SHA256 7f697e897ce7a851caa4283eeb3eab8115737a75e58273a70991cd88c30d7eae
- /api/v1/canvases?limit=30｜352 bytes｜字段 12｜数组 1｜SHA256 bba20799f2c38cf76ca8a5d1338accb9c2fce2b96a56b575e085a06238001ab6
- /api/v1/canvases/{id}｜484 bytes｜字段 19｜数组 3｜SHA256 a82fa7ca0ad840b2c57d37816c4ff00e8caf96b760aa198359b3b6e1dd37ba60
- /api/v1/model-routes/public｜5971 bytes｜字段 103｜数组 13｜SHA256 d639dd78b5b0eef1b404bc2cafd636597b9b1270a8f4f0ee6e6de60b0a977421
- /api/v1/model-routes/public?sha256=%7Bvalue%7D｜5721 bytes｜字段 103｜数组 13｜SHA256 c92ca9470f8ab068d16a7b9717673ad0c02621d5782846ca8c05d60f615fc41f
- /api/v1/operation-notices/current｜5 bytes｜字段 1｜数组 0｜SHA256 38e0b9de817f645c4bec37c0d4a3e58baecccb040f5718dc069a72c7385a0bed
- /api/v1/payments/recharge-packages｜12839 bytes｜字段 46｜数组 4｜SHA256 052ac9095a3dc434bbccfefcdf73d351db0a0b19af9ab0fd8f8c1af520b871be
- /api/v1/public/settings｜183 bytes｜字段 5｜数组 1｜SHA256 0418c6127a444a8d4f6c38067999fc26e3a39ac0988c5289a7a87ad848186ea5
- /api/v1/tools/image-generation/skill-packs｜36855 bytes｜字段 55｜数组 6｜SHA256 5f445cd17a567c3430d9a9625913b2048ddec5da7e735f3694eaa71993abbc9c
- /api/v1/usage/ledger?limit=15｜13055 bytes｜字段 25｜数组 1｜SHA256 a82fc35a7077ca0ec9275779a5bdfd04ea2fed780ed6219ab485f1fb0b786616
- /api/v1/usage/summary｜7188 bytes｜字段 45｜数组 3｜SHA256 8ad447799e72a4506b62d71969d90daee319ddaa22c6f0e43f1ad8d51462ed3e
- /api/v1/user-migrations/current｜1787 bytes｜字段 20｜数组 1｜SHA256 7329026b2e4de424074f19ceb7e7037dae153778d1fcc6b4847f71b770bc1055
- /api/v1/voice-profiles｜18 bytes｜字段 2｜数组 1｜SHA256 0343639fac1511a32a4c9a92c7655a6e9f9ad3a600fc6f30b5bdad6806160a97
- /api/v1/voice-profiles/system-voices｜11381 bytes｜字段 9｜数组 1｜SHA256 08e2c5836d3e94977418faa1fee6370a9bc4e36e54edb5f239bc47c19937540b

## 证据边界

- Write-only behavior, paid generation, provider execution, private queue workers, database transactions and server-only prompt code remain outside browser GET evidence.

