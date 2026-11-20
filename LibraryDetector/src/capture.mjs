export function fitImage(width, height, maxEdge = 6000, maxPixels = 18000000) {
  const scale = Math.min(1, maxEdge / Math.max(width,height), Math.sqrt(maxPixels/(width*height)));
  return {width:Math.max(1,Math.round(width*scale)),height:Math.max(1,Math.round(height*scale))};
}
export function cameraConstraints(deviceId) {
  return {audio:false,video:{...(deviceId?{deviceId:{exact:deviceId}}:{facingMode:{ideal:'environment'}}),
    width:{ideal:3840},height:{ideal:2160},frameRate:{ideal:15,max:30}}};
}
export async function tuneCamera(track) {
  const caps=track.getCapabilities?.()??{};
  const advanced={};
  if(caps.focusMode?.includes('continuous'))advanced.focusMode='continuous';
  if(caps.exposureMode?.includes('continuous'))advanced.exposureMode='continuous';
  if(caps.whiteBalanceMode?.includes('continuous'))advanced.whiteBalanceMode='continuous';
  if(Object.keys(advanced).length)try{await track.applyConstraints({advanced:[advanced]});}catch{/* Optional capabilities vary by browser. */}
  return caps;
}
// Full-resolution stills when available; Safari/unsupported devices use video.
export async function captureSource(video, track, report = () => {}) {
  if(track && typeof globalThis.ImageCapture==='function' && typeof globalThis.createImageBitmap==='function') {
    try {
      const camera=new ImageCapture(track), caps=await camera.getPhotoCapabilities();
      const settings={};
      if(caps.imageWidth?.max)settings.imageWidth=caps.imageWidth.max;
      if(caps.imageHeight?.max)settings.imageHeight=caps.imageHeight.max;
      const blob=await camera.takePhoto(settings);
      const bitmap=await createImageBitmap(blob);
      return {image:bitmap,width:bitmap.width,height:bitmap.height,kind:'고해상도 사진',close:()=>bitmap.close()};
    } catch { report('사진 촬영 API를 사용할 수 없어 카메라 원본 프레임을 사용합니다.'); }
  }
  if(video.readyState<2 || !video.videoWidth)throw Error('카메라 영상이 아직 준비되지 않았습니다.');
  return {image:video,width:video.videoWidth,height:video.videoHeight,kind:'카메라 프레임',close(){}};
}
