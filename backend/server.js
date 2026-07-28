const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 5000;

const DOWNLOAD_DIR = path.join(__dirname, "downloads");

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}


// ===============================
// CORS CONFIG
// ===============================

const allowedOrigins = [
  "http://localhost:5173",
  "https://yt-dowloader-cfol.onrender.com",
  process.env.CLIENT_ORIGIN
];


app.use(
  cors({
    origin: (origin, callback) => {

      // allow curl/postman/server requests
      if (!origin) {
        return callback(null, true);
      }


      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }


      // allow vercel preview deployments
      if (
        origin.includes("vercel.app")
      ) {
        return callback(null, true);
      }


      console.log("[CORS BLOCKED]", origin);

      callback(new Error("Not allowed by CORS"));
    }
  })
);


app.use(express.json());


// ===============================
// YOUTUBE URL VALIDATION
// ===============================


const YT_URL_REGEX =
/^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/)|youtu\.be\/)[\w-]+/i;


function isValidYoutubeUrl(url){

  return (
    typeof url === "string" &&
    YT_URL_REGEX.test(url.trim())
  );

}


// ===============================
// JOB STORE
// ===============================


const jobs = new Map();



function createJobId(){

  return crypto.randomBytes(8).toString("hex");

}



function broadcast(jobId){

  const job = jobs.get(jobId);

  if(!job) return;


  const data = JSON.stringify({
    status: job.status,
    progress: job.progress,
    error: job.error || null,
    fileName: job.fileName || null
  });


  job.clients.forEach(client=>{
    client.write(
      `data: ${data}\n\n`
    );
  });

}


// ===============================
// YT-DLP CONFIG
// ===============================


function ytDlpCommonArgs(){

  return [

    // solve YouTube JS challenges
    "--js-runtimes",
    "deno",


    // better client
    "--extractor-args",
    "youtube:player_client=web",


    // no playlist
    "--no-playlist",


    // retry
    "--retries",
    "3",

    "--fragment-retries",
    "3"

  ];

}



// ===============================
// VIDEO INFO
// ===============================


app.post("/api/info", async(req,res)=>{


  const {url}=req.body;


  if(!isValidYoutubeUrl(url)){
    return res.status(400).json({
      message:"Invalid YouTube URL"
    });
  }



  try{


    const response = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`
    );


    if(!response.ok){
      throw new Error("oembed failed");
    }



    const data = await response.json();


    res.json({

      title:data.title,

      thumbnail:data.thumbnail_url,

      uploader:data.author_name,

      duration:null,

      views:null

    });



  }
  catch(err){

    console.log(
      "[INFO ERROR]",
      err.message
    );


    res.status(500).json({

      message:
      "Couldn't load video info"

    });

  }


});



// ===============================
// DOWNLOAD API
// ===============================


app.post("/api/download",(req,res)=>{


const {
url,
type,
quality
}=req.body;



if(!isValidYoutubeUrl(url)){

return res.status(400).json({
message:"Invalid URL"
});

}



if(!["video","audio"].includes(type)){

return res.status(400).json({
message:"Invalid type"
});

}



const jobId=createJobId();



const output =
path.join(
DOWNLOAD_DIR,
`${jobId}.%(ext)s`
);



jobs.set(jobId,{

status:"starting",

progress:0,

clients:[]

});



let args=[];



if(type==="video"){


const height={
"1080p":1080,
"720p":720,
"480p":480
};



const selectedHeight =
height[quality];



const format =
selectedHeight

?
`bv*[height<=${selectedHeight}]+ba/b`

:
"bv*+ba/b";



args=[

...ytDlpCommonArgs(),

"-f",
format,


"--merge-output-format",
"mp4",


"-o",
output,


"--newline",


url

];


}
else{


args=[

...ytDlpCommonArgs(),

"-x",

"--audio-format",
"mp3",

"-o",
output,


"--newline",


url

];


}

// ===============================
// START YT-DLP PROCESS
// ===============================


const child = spawn(
  "yt-dlp",
  args
);



child.stdout.on(
"data",
(chunk)=>{

const text = chunk.toString();


const match =
text.match(/(\d{1,3}\.\d)%/);


const job = jobs.get(jobId);



if(job && match){

job.status="downloading";

job.progress =
parseFloat(match[1]);


broadcast(jobId);

}


});



child.stderr.on(
"data",
(chunk)=>{


const error =
chunk.toString();


console.log(
`[yt-dlp ${jobId}]`,
error.trim()
);



const job =
jobs.get(jobId);



if(
error.includes("429") ||
error.includes("Sign in to confirm")
){

if(job){

job.error =
"YouTube blocked this request. Try again later.";

}

}



});





child.on(
"error",
(err)=>{


const job =
jobs.get(jobId);


if(!job) return;



job.status="error";


job.error =
"yt-dlp is not installed on server";


broadcast(jobId);


});





child.on(
"close",
(code)=>{


const job =
jobs.get(jobId);



if(!job) return;



if(code!==0){


job.status="error";


if(!job.error){

job.error =
"Download failed. YouTube rejected request.";

}


broadcast(jobId);


return;


}





const files =
fs.readdirSync(DOWNLOAD_DIR)
.filter(
file=>file.startsWith(jobId)
);



if(files.length===0){


job.status="error";


job.error =
"Downloaded file not found";


broadcast(jobId);


return;


}




job.status="done";


job.progress=100;


job.filePath =
path.join(
DOWNLOAD_DIR,
files[0]
);


job.fileName =
files[0];


broadcast(jobId);



job.clients.forEach(
client=>client.end()
);



});




res.json({

jobId

});


});




// ===============================
// SSE PROGRESS
// ===============================


app.get(
"/api/progress/:jobId",
(req,res)=>{


const job =
jobs.get(req.params.jobId);



if(!job){

return res.status(404).end();

}



res.writeHead(200,{

"Content-Type":
"text/event-stream",

"Cache-Control":
"no-cache",

"Connection":
"keep-alive"

});



res.write(
`data: ${JSON.stringify({
status:job.status,
progress:job.progress
})}\n\n`
);



job.clients.push(res);



req.on(
"close",
()=>{

job.clients =
job.clients.filter(
client=>client!==res
);


});


});




// ===============================
// DOWNLOAD FILE
// ===============================


app.get(
"/api/file/:jobId",
(req,res)=>{


const job =
jobs.get(req.params.jobId);



if(
!job ||
job.status!=="done" ||
!fs.existsSync(job.filePath)
){

return res.status(404).json({

message:
"File not ready"

});


}



res.download(
job.filePath,
job.fileName
);



});





// ===============================
// CLEAN OLD FILES
// ===============================


setInterval(()=>{


fs.readdir(
DOWNLOAD_DIR,
(err,files)=>{


if(err)return;



const now =
Date.now();



files.forEach(file=>{


const filePath =
path.join(
DOWNLOAD_DIR,
file
);



fs.stat(
filePath,
(err,stats)=>{


if(err)return;



if(
now - stats.mtimeMs >
60*60*1000
){

fs.unlink(
filePath,
()=>{}
);

}


});


});


});


},30*60*1000);




// ===============================
// SERVER START
// ===============================


app.listen(
PORT,
()=>{

console.log(
`Server running on http://localhost:${PORT}`
);

});