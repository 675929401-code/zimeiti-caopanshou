import React from 'react';
import {AbsoluteFill,Composition,Img,interpolate,registerRoot,Sequence,useCurrentFrame,useVideoConfig} from 'remotion';
function Scene({scene,color,frames}){
 const frame=useCurrentFrame();
 const opacity=interpolate(frame,[0,6,frames-6,frames-1],[0,1,1,0],{extrapolateLeft:'clamp',extrapolateRight:'clamp'});
 const rise=interpolate(frame,[0,9],[16,0],{extrapolateRight:'clamp'});
 return <AbsoluteFill style={{backgroundColor:'#171717',color:'#fff',opacity,fontFamily:'Arial, Microsoft YaHei, sans-serif',display:'flex',justifyContent:'flex-end'}}>
  {scene.image&&<Img src={scene.image} style={{position:'absolute',width:'100%',height:'100%',objectFit:'cover',opacity:.78}}/>}
  <div style={{position:'relative',padding:'6%',background:'linear-gradient(transparent,rgba(0,0,0,.84))',transform:'translateY('+rise+'px)'}}>
   <div style={{background:color,width:64,height:7,marginBottom:15}}/>
   <div style={{fontSize:42,fontWeight:700,overflowWrap:'anywhere'}}>{scene.title}</div>
   {scene.caption&&<div style={{fontSize:25,lineHeight:1.4,marginTop:10,overflowWrap:'anywhere'}}>{scene.caption}</div>}
  </div></AbsoluteFill>;
}
function Story({scenes,color}){const {fps}=useVideoConfig();let start=0;return <AbsoluteFill style={{background:'#171717'}}>{scenes.map((s,i)=>{const from=start,n=Math.round(s.duration*fps);start+=n;return <Sequence key={i} from={from} durationInFrames={n}><Scene scene={s} color={color} frames={n}/></Sequence>})}</AbsoluteFill>;}
function Root(){return <Composition id="CommerceStory" component={Story} durationInFrames={72} fps={24} width={720} height={1280} defaultProps={{scenes:[{title:'',duration:3}],color:'#0471FE',portrait:true}} calculateMetadata={({props})=>({durationInFrames:props.scenes.reduce((sum,s)=>sum+Math.round(s.duration*24),0),width:props.portrait?720:1280,height:props.portrait?1280:720})}/>;}
registerRoot(Root);
