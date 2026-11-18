const {renderOfflineVideo}=require('./offline-render');

// Analysis shares the export driver's resource/animation checks. It must not
// estimate duration by recording wall-clock playback and then silently switch
// the actual export to a different timing model.
async function analyzePage(options){
 return renderOfflineVideo({...options,analyzeOnly:true});
}
module.exports={analyzePage};
