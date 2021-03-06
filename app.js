// Require express and body-parser
const express = require("express")
const bodyParser = require("body-parser")
const { ApiError, Client, Environment } = require('square')

const fs = require('fs');
const readline = require('readline');
const {google} = require('googleapis');
const cheerio = require('cheerio');
const axios = require('axios');
var base64 = require('js-base64').Base64;

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets.readonly',
];

const TOKEN_PATH = 'token.json'
var SQUARE_MENU = [];

//make instance of api client and give it the credentials it needs
const client = new Client({
  timeout:3000,
  environment: Environment.Production,
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
})

//instance of square's order api
const { ordersApi } = client

// Initialize express and define a port
const app = express()
const PORT = (process.env.PORT || 5000)

// Tell express to use body-parser's JSON parsing
app.use(bodyParser.json())

// Start express on the defined port
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  fs.readFile('credentials.json', (err, content) => {
    if (err) return console.log('Error loading client secret file:', err);
    authorize(JSON.parse(content), getMenu);
  });
});

//get menu from sheets on startup
app.use(bodyParser.json())

app.post("/", (req, res) => {
  //only if type is payment.updated and processing fee exists
  //MAKE SURE TO ADD CHECK SO NO TWO PAYMENT UPDATES!!!
  if( (req.body.type === "payment.updated") 
      && (typeof req.body.data.object.payment.processing_fee !== "undefined")
      && (req.body.data.object.payment.card_details.status === "CAPTURED" ) ) {
    let shippingAddress =  req.body.data.object.payment.shipping_address;
    let emailAddress = req.body.data.object.payment.buyer_email_address;
    let postedOrderId = req.body.data.object.payment.order_id
    // Call your action on the request here
    var myOrder = getOrderById(postedOrderId, shippingAddress, emailAddress)
    const myLineItems = myOrder.then( res => getLineItems(res))
    const myReceiptBody = myLineItems.then( res => makeReceiptBody(res))
  }
  res.status(200).end() // Responding is important
})

app.get("/", (req,res) => {
  console.log("Accessed Homepage!")
  res.status(200).end()
})

const getOrderById = async (orderId, shippingInfo, emailAddress) => {
  try {
    let response = await client.ordersApi.retrieveOrder(orderId);
    response.result.order.myShippingAddress = shippingInfo;
    response.result.order.myEmailAddress = emailAddress;
    return response
  } catch(error) {
    if (error instanceof ApiError){
      console.log("There was an error in your request: ", error.errors)
    } else {
      console.log("Unexpected Error: ", error)
    }
  }
}

const getLineItems = async (orderObj) => {
  try {
    for (lineItem of orderObj.result.order.lineItems) {
      let sheetItem = SQUARE_MENU.find(element => element.name === lineItem.name.toUpperCase())
      if(typeof sheetItem === "undefined"){
        lineItem.printer = '';
        console.log(lineItem.name + " has no entry in the google spreadsheet")
      } else {
        lineItem.printer = sheetItem.printers
      }
      console.log(lineItem.quantity, lineItem.name, lineItem.printer)
    }
    return orderObj;
  } catch(error) {
    if (error instanceof ApiError){
      console.log("There was an error in your request: ", error.errors)
    } else {
      console.log("Unexpected Error: ", error)
    }
  }
}
const makeReceiptBody = async (orderObj) => {
  //set up receipt object
  try {
    let receipts = {};
    receipts.foodrun = '';
    receipts.entree = '';
    receipts.app = '';
    receipts.dessert = '';
    //add line items to assigned receipts by printer id
    for (lineItem of orderObj.result.order.lineItems){
      if(typeof lineItem.note === "undefined"){
        lineItem.note = '';
      }
      if(typeof lineItem.modifiers === "undefined"){
        lineItem.modifiers = [];
      }
      if(lineItem.name === "Restaurant Week Set for 2"){
        mod_names = ["Mekong Clams", "Lao Street Noodle", "Spicy Pork Pho", "Kana Hed Krob", "Lod Chong", "Taro Cake"]
        for( let i = 0; i < mod_names.length; i++ ){
          let mod_obj = {};
          mod_obj.name = mod_names[i];
          lineItem.modifiers.push(mod_obj);
        }
      }
      if(lineItem.name === "Valentine's Set for 2"){
        mod_names = ["Shrimp Croquettes", "Violet Floral", "Baan Poo", "Mekong Clams", "Coconut Pandan Cake"]
        for( let i = 0; i < mod_names.length; i++ ){
          let mod_obj = {};
          mod_obj.name = mod_names[i];
          lineItem.modifiers.push(mod_obj);
        }
      }

      let allModsHTML = '';
      //console.log(lineItem.modifiers);
      for(let mod = 0; mod < lineItem.modifiers.length; mod++){
        let listItem=lineItem.modifiers[mod].name;
        allModsHTML += "<li>" + listItem + "</li>"
      }

      let myMarkup = `
        <div>
        <h4>
        <p>${lineItem.quantity } ${lineItem.name}</p>
        <ul style="list-style-type:none">
      `
      let myNote = `
          <li>${lineItem.note}</li>
        </ul>
        </h4>
        </div>
      `;
      myMarkup += allModsHTML + myNote;
      //console.log(myMarkup);

      receipts.foodrun += myMarkup;
      if(lineItem.printer.includes('E')){
        receipts.entree += myMarkup;
      }
      if(lineItem.printer.includes('A')){
        receipts.app += myMarkup;
      }
      if(lineItem.printer.includes('D')){
        receipts.dessert += myMarkup;
      }            
    }
    orderObj.result.order.receipts = receipts;
    //console.log(orderObj.result.order.receipts);
    // fill in puckup information
    let placed = '';
    let pickup;
    let recipient_name = '';
    let recipient_phone = '';
    let shipping_address = '';
    //console.log(orderObj.result.order.fulfillments);

    if (typeof orderObj.result.order.fulfillments !== "undefined"){
      if (orderObj.result.order.fulfillments[0].type === "PICKUP"){
        recipient_name = orderObj.result.order.fulfillments[0].pickupDetails.recipient.displayName;
        recipient_phone = orderObj.result.order.fulfillments[0].pickupDetails.recipient.phoneNumber;
        placed = orderObj.result.order.fulfillments[0].pickupDetails.placedAt;
        placed = new Date(Date.parse(placed));

        if (orderObj.result.order.fulfillments[0].pickupDetails.scheduleType === "SCHEDULED"){
          pickup = "<strong>WAIT TO MAKE ORDER!</strong>";
        }else{
          pickup = new Date(Date.parse(placed));
          pickup = pickup.getTime() + 20*60000; //20 minutes to prepare
          pickup = formatAMPM(pickup);
        }
        
        placed = formatAMPM(placed)
        if (typeof recipient_phone !== "undefined"){
          if (recipient_phone.length >= 10){
            recipient_phone = recipient_phone.substring(recipient_phone.length - 10);
            recipient_phone = '(' + recipient_phone.substring(0,3) + ')' + recipient_phone.substring(3,6) + '-' + recipient_phone.substring(6);
          }
        }
      }else if (orderObj.result.order.fulfillments[0].type === "DELIVERY"){
        shipping_address = orderObj.result.order.myShippingAddress.address_line_1 + ", " + orderObj.result.order.myShippingAddress.administrative_district_level_1;
        //console.log(shipping_address);
        placed = orderObj.result.order.createdAt;
        pickup = new Date(Date.parse(placed));
        pickup = pickup.getTime() + 20*60000; //20 minutes to prepare
        pickup = formatAMPM(pickup);
        placed = formatAMPM(placed)
      }
      console.log(`
      Placed at: ${placed}
      Ready by: ${pickup}
      Name: ${recipient_name}
      Phone: ${recipient_phone}
      -----------------------------
      `);
    }
    /*
    var mySearch = {
      query : { 
        filter : {
          emailAddress: {
            exact : ""
          }
        }
      }
    };
    mySearch.query.filter.emailAddress.exact = orderObj.result.order.myEmailAddress;
    console.log(mySearch.query.filter.emailAddress.exact);
    const customer = await client.customersApi.searchCustomers(mySearch);

    console.log(customer);
    console.log(customer.result);
    if(typeof customer.result !== "undefined"){
      if(typeof customer.result.customers !== "undefined"){
        recipient_name = customer.result.customers[0].givenName + " " + customer.result.customers[0].familyName;
        recipient_phone = customer.result.customers[0].phoneNumber;
      }
      if (typeof recipient_phone !== "undefined"){
        if (recipient_phone.length >= 10){
          recipient_phone = recipient_phone.substring(recipient_phone.length - 10);
          recipient_phone = '(' + recipient_phone.substring(0,3) + ')' + recipient_phone.substring(3,6) + '-' + recipient_phone.substring(6);
        }
      }
    }
    */

    let customer_info =`
      <h3>
        <div> ${recipient_name} </div>
        <div> ${recipient_phone} </div>  
        <div> ${shipping_address} </div>
      </h3>
      <p> Placed at: ${placed} </p> 
      <p> Ready by: ${pickup} </p>
    `;
    let header = `
      <!DOCTYPE html>
      <html>
      <head> 
        <style>
          .right {float: right;}
          .left {float: left;}
        </style>
      </head> 
      <body>
    `;
    let footer = `
        <hr>
      </body>
      </html>
    `;

    for(let i in orderObj.result.order.receipts){
      if(orderObj.result.order.receipts[i] !== ''){
        orderObj.result.order.receipts[i] = customer_info + printerHTML(i) + orderObj.result.order.receipts[i];
        orderObj.result.order.receipts[i] = header + orderObj.result.order.receipts[i] + footer;
      }
    }
    //console.log(orderObj.result.order.receipts.foodrun);
    var postData = {
      orderId: 'square',
      foodrunHTML: '',
      entreeHTML: '',
      appHTML: '',
      dessertHTML: ''
    }
    //postData.foodrunHTML = orderObj.result.order.receipts.foodrun;

    if (typeof orderObj.result.order.fulfillments[0].pickupDetails !== 'undefined'){
      if (orderObj.result.order.fulfillments[0].pickupDetails.scheduleType === "SCHEDULED"){
        postData.foodrunHTML = `
          <h4>
          <p>Order scheduled for:</p>
          <p><strong>${recipient_name}.</strong></p>
          <p>Wait to make order!</p>
          </h4>
        `;
        postData.foodrunHTML = header + postData.foodrunHTML + footer;
      }
    }
    postData.foodrunHTML = orderObj.result.order.receipts.foodrun;
    postData.entreeHTML = orderObj.result.order.receipts.entree;
    postData.appHTML = orderObj.result.order.receipts.app;
    postData.dessertHTML = orderObj.result.order.receipts.dessert;
    //console.log(postData);

    axios
      .post('https://minutely-emu-9286.dataplicity.io/', postData)
      .catch(function (error) {
        console.log(error);
      });


    //console.log(orderObj.result.order);

    //console.log(postData);
    return(orderObj);
  }catch(error){
    if (error instanceof ApiError){
      console.log("There was an error in your request: ", error.errors)
    } else {
      console.log("Unexpected Error: ", error)
    }   
  }
}

function printerHTML(printerName){
  let printer_info =`
    <div>
      <span class= "right">${printerName.charAt(0).toUpperCase() + printerName.slice(1)}</span>
      <span class= "left">Square</span>
    </div>
    <br>
    <hr>
  `;
  return printer_info;
}

function formatAMPM(d){
  d = new Date(d);
  let hours = d.getHours();
  let ampm = hours > 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  let minutes = d.getMinutes()
  minutes = minutes < 10 ? "0"+minutes : minutes;
  let month = d.getMonth();
  let date = d.getDate();
  let year = d.getFullYear();
  return hours + ":" + minutes + " " + ampm + ", " + month + "/" + date + "/" + year;
}

function authorize(credentials, callback) {
  const {client_secret, client_id, redirect_uris} = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(
      client_id, client_secret, redirect_uris[0]);

  // Check if we have previously stored a token.
  fs.readFile(TOKEN_PATH, (err, token) => {
    if (err) return getNewToken(oAuth2Client, callback);
    oAuth2Client.setCredentials(JSON.parse(token));
    callback(oAuth2Client);
  });
}

function getNewToken(oAuth2Client, callback) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  console.log('Authorize this app by visiting this url:', authUrl);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.question('Enter the code from that page here: ', (code) => {
    rl.close();
    oAuth2Client.getToken(code, (err, token) => {
      if (err) return console.error('Error retrieving access token', err);
      oAuth2Client.setCredentials(token);
      // Store the token to disk for later program executions
      fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
        if (err) return console.error(err);
        console.log('Token stored to', TOKEN_PATH);
      });
      callback(oAuth2Client);
    });
  });
}

function getMenu(auth) {
  console.log("Retreiving google sheets printer information");
  const sheets = google.sheets({version: 'v4', auth});
  sheets.spreadsheets.values.get({
  spreadsheetId: '12korJTxZqi0Zz3ff20U73L5_6y-A2D1wzfkzLv3qMaU',
  range: 'Sheet1!A:B',
  }, async (err, response) => {
  if (err) return console.log('The API returned an error: ' + err);
  const rows = await response.data.values;
  for(let row = 0; row < rows.length; row++){
    let item = {};
    item.name = rows[row][0];
    item.printers = ""
    if( !(typeof rows[row][1] === "undefined") ){
      item.printers += rows[row][1];
    }
    SQUARE_MENU.push(item);
  }
  console.log("Loaded Menu!")
  for(let i = 0; i < SQUARE_MENU.length; i++){
    if(typeof SQUARE_MENU[i].name !== 'undefined'){
      SQUARE_MENU[i].name = SQUARE_MENU[i].name.toUpperCase();
    }
  }
  //console.log(SQUARE_MENU);
  })
}

