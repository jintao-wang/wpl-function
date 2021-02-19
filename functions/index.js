const functions = require('firebase-functions');
const express = require('express');
const bodyParse = require('body-parser');
const fetch = require('node-fetch');

const cookieParser = require('cookie-parser')();
const cors = require('cors')({origin: true});

// util
const getTime = (timestamp = null) => {
    // eslint-disable-next-line no-extend-native
    Date.prototype.format = function (fmt) {
        const o = {
            'M+': this.getMonth() + 1, // 月份
            'd+': this.getDate(), // 日
            'h+': this.getHours(), // 小时
            'm+': this.getMinutes(), // 分
            's+': this.getSeconds(), // 秒
            'q+': Math.floor((this.getMonth() + 3) / 3), // 季度
            S: this.getMilliseconds(), // 毫秒
        };
        if (/(y+)/.test(fmt)) {
            // eslint-disable-next-line no-param-reassign
            fmt = fmt.replace(RegExp.$1, (`${this.getFullYear()}`).substr(4 - RegExp.$1.length));
        }
        // eslint-disable-next-line no-restricted-syntax
        for (const k in o) {
            if (new RegExp(`(${k})`).test(fmt)) {
                // eslint-disable-next-line no-param-reassign,eqeqeq
                fmt = fmt.replace(RegExp.$1, (RegExp.$1.length == 1) ? (o[k]) : ((`00${o[k]}`).substr((`${o[k]}`).length)));
            }
        }
        return fmt;
    };
    if (timestamp) {
        return new Date(timestamp);
    }
    return new Date();
};

const app = express();
const noAuth = express();

const admin = require('firebase-admin');
admin.initializeApp();

noAuth.all('*', function(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "*");
    res.header("Access-Control-Allow-Methods","PUT,POST,GET,DELETE,OPTIONS");
    next();
});


const validateFirebaseIdToken = async (req, res, next) => {
    console.log('Check if request is authorized with Firebase ID token');

    if ((!req.headers.authorization || !req.headers.authorization.startsWith('Bearer ')) &&
        !(req.cookies && req.cookies.__session)) {
        console.error('No Firebase ID token was passed as a Bearer token in the Authorization header.',
            'Make sure you authorize your request by providing the following HTTP header:',
            'Authorization: Bearer <Firebase ID Token>',
            'or by passing a "__session" cookie.');
        res.status(403).send('Unauthorized');
        return;
    }

    let idToken;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        console.log('Found "Authorization" header');
        // Read the ID Token from the Authorization header.
        idToken = req.headers.authorization.split('Bearer ')[1];
    } else if(req.cookies) {
        console.log('Found "__session" cookie');
        // Read the ID Token from cookie.
        idToken = req.cookies.__session;
    } else {
        // No cookie
        res.status(403).send('Unauthorized');
        return;
    }

    try {
        const decodedIdToken = await admin.auth().verifyIdToken(idToken);
        console.log('ID Token correctly decoded', decodedIdToken);
        req.user = decodedIdToken;
        next();
        return;
    } catch (error) {
        console.error('Error while verifying Firebase ID token:', error);
        res.status(403).send('Unauthorized');
        return;
    }
};

app.use(bodyParse.urlencoded({extended:false}))
app.use(cors);
app.use(cookieParser);
app.use(validateFirebaseIdToken);

app.get('/test', (request, response) => {
    admin.firestore().collection('items').get()
        // eslint-disable-next-line promise/always-return
        .then(snapshot => {
            let allResult = new Array();
            snapshot.forEach(doc => {
                allResult.push(doc.data())
            });
            response.send(allResult);
        })
        .catch(err => {
            response.send('Error getting all document', err);
        })
})

app.get('/getUserId', (req, res) => {
    res.send(req.user)
})

app.post('/register', (req, res) => {
    admin.firestore().collection("user").doc(req.user.uid).set({
        email: req.user.email,
        totalCart: 0
    })
        .then(() => res.send("registerSuccess"))
        .catch(error => console.error("Error adding document: ", error))
})

app.post('/depositBooking', async (req,res) => {
    const body = req.body
    const oneNumber = parseInt(body.oneNumber)
    const twoNumber = parseInt(body.twoNumber)
    const threeNumber = parseInt(body.threeNumber)
    const totalNumber = oneNumber + twoNumber + threeNumber
    const startDate = new Date(body.startDate)
    const endDate = new Date(body.endDate)
    const weeks =  Math.ceil((Date.parse(body.endDate) - Date.parse(body.startDate)) / 1000/60/60/24/7)
    const totalPrice = (oneNumber+ 2*twoNumber+ 3*threeNumber)*weeks

    await admin.firestore().collection('deposit').add({
        oneNumber: oneNumber,
        twoNumber: twoNumber,
        threeNumber: threeNumber,
        totalNumber: totalNumber,
        startDate: startDate,
        endDate: endDate,
        weeks: weeks,
        user: req.user.uid,
        totalPrice: totalPrice
    });
    res.send({
        state: 200,
        payload: "booking success"
    })
    const tokenRef =  admin.firestore().collection("tokens").doc('wechat');
    const doc = await tokenRef.get();
    if (!doc.exists) return;
    const result = doc.data();
    let text = '';
    if(oneNumber) {
        text += `吉他/中箱/登机箱数量: ${oneNumber}\n`
    }
    if(twoNumber) {
        text += `大箱数量: ${twoNumber}\n`
    }
    if(threeNumber) {
        text += `行李箱/超出尺寸箱数量: ${threeNumber}\n`
    }
    const params = {
        touser: "WangJinTao|HongXia",
        msgtype: "text",
        agentid: 1000002,
        text: {
            content: `测试 有新的寄存订单啦!\n\n${text}寄存开始时间： ${getTime(startDate).format('yyyy-MM-dd')}\n寄存结束时间： ${getTime(body.endDate).format('yyyy-MM-dd')}\n寄存周数： ${weeks}周\n寄存价格：£${totalPrice}
            `,
        }
    }
    // 判断token是否超时，超时重新请求并更新token和时间
    if(result.expires_in < new Date().getTime()) {
        const getTokenRes = await fetch('https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=ww4efc014f0d230828&corpsecret=GSbjyqZ7jzaQH72q1H_QlkKoXwo6vGu5ZKhFKdz3ZPo');
        // 请求失败
        if (!getTokenRes.ok) return;
        const result = await getTokenRes.json();
        const expires_in = new Date().getTime() + result.expires_in * 1000;

        await tokenRef.update({
            access_token: result.access_token,
            expires_in: expires_in.toString(),
        });

        await fetch(
          `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${result.access_token}`,
          {
              method: 'POST',
              body: JSON.stringify(params),
          },
        )
        return;
    }
    await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${result.access_token}`,
      {
          method: 'POST',
          body: JSON.stringify(params),
      },
    )
})

noAuth.get('/getAllItems', (req, res) => {
    admin.firestore().collection("items").get()
        // eslint-disable-next-line promise/always-return
        .then(collection => {
            let items = new Array()
            collection.forEach(doc => {
                let data = doc.data()
                data.id = doc.id
                items.push(data)
            })
            res.send({
                state: 200,
                payload: items
            })
        })
        .catch(err => {
            res.send({
                state: 400,
                payload: err
            })
        })
})

noAuth.get('/testGetToken', async (req, res) => {
    const tokenRef =  admin.firestore().collection("tokens").doc('wechat');
    const doc = await tokenRef.get();
    if (!doc.exists) {
        res.send({
            state: 400,
            payload: 'No such document!'
        })
        return;
    }
    const result = doc.data();
    // 判断token是否超时，超时重新请求并更新token和时间
    if(result.expires_in < new Date().getTime()) {
        const response = await fetch('https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=ww503c896be35d7350&corpsecret=mcYwnfCPQS3xpjyUPUmDDIDhcjQlKwHAq2BKx1pnghE');
        // 请求失败
        if (!response.ok) {
            res.send({
                state: 400,
                payload: 'Get token form wechat failed!',
            })
        }
        const result = await response.json();
        const expires_in = new Date().getTime() + result.expires_in * 1000;
        res.send({
            state: 200,
            payload: {
                access_token: result.access_token,
                expires_in: expires_in.toString(),
                source: 'wechatApi',
            },
        })
        await tokenRef.update({
            access_token: result.access_token,
            expires_in: expires_in.toString(),
        });
        return;
    }

    res.send({
        state: 200,
        payload: doc.data(),
        source: 'firebaseCache',
    })
})

exports.app = functions.region('europe-west2').https.onRequest(app);
exports.noAuth = functions.region('europe-west2').https.onRequest(noAuth);
