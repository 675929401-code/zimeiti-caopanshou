import path from 'node:path';
import {fileURLToPath} from 'node:url';
const directory=path.dirname(fileURLToPath(import.meta.url));
/** Original UI uses its own document and styles. Provider requests belong to the main BFF. */
export default {
  basePath:'/publish-center/native',
  async redirects(){return [{source:'/',destination:'/zh-CN',permanent:false}];},
  output:'standalone',
  outputFileTracingRoot:directory,
  images:{unoptimized:true},
  poweredByHeader:false,
  productionBrowserSourceMaps:false,
  typescript:{ignoreBuildErrors:false},
  experimental:{cpus:2,webpackMemoryOptimizations:true},
  webpack(config){
    config.resolve.alias={...config.resolve.alias,zod:path.resolve(directory,'node_modules/zod')};
    config.module.rules.push({test:/\.svg$/,use:['@svgr/webpack'],exclude:path.resolve(directory,'src/assets/svgs/plat')});
    config.module.rules.push({test:/\.svg$/,include:path.resolve(directory,'src/assets/svgs/plat'),type:'asset/resource'});
    return config;
  },
};
