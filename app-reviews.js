'use strict';

const APP_STORE_APPS = require('./apps-app-store.json');
const PLAY_STORE_APPS = require('./apps-google-play.json');
const FRIENDLY_STORE_NAMES = { 'app-store': 'App Store', 'google-play': 'Google Play' }

const AWS = require('aws-sdk'); // eslint-disable-line import/no-extraneous-dependencies
const AppStore = require('app-store-scraper');
const PlayStore = require('google-play-scraper');
const Request = require('request-promise-native')


const DynamoDb = new AWS.DynamoDB.DocumentClient();

async function start() {
  var appStore = APP_STORE_APPS.map(fetchFromAppStore);
  var playStore = PLAY_STORE_APPS.map(fetchFromGooglePlay);

  return Promise.all([].concat(playStore, appStore)).then((result) => {
    console.log('Finished checking for new reviews');
    return [].concat.apply([], result);
  });
}

async function fetchFromAppStore(app) {
  var results = []
  try {
    for(var country, i = 0; country = app.countries[i]; i++) {
      console.log('Fetching reviews for: ', { id: app.appId, country: country });
      var reviews = await AppStore.reviews({ id: app.appId, country: country });
      app.store = 'app-store';
      app.cacheKey = [app.store, country, app.appId].join('-');
      results.push(await handleReviews(reviews, app));
    }
  }
  catch(e) {
    console.error(`Error fetching reviews for appstore:${app.appId}`, e);
    
  }
  return results;
}

async function fetchFromGooglePlay(app) {
  var results = []
  try {
    for(var language, i = 0; language = app.languages[i]; i++) {
      console.log('Fetching reviews for: ', { appId: app.appId, lang: language });
      var reviews = await PlayStore.reviews({ appId: app.appId, lang: language });
      app.store = 'google-play';
      app.cacheKey = [app.store, language, app.appId].join('-');
      results.push(await handleReviews(reviews, app));
    }
  }
  catch(e) {
    console.error(`Error fetching reviews for googleplay:${app.appId}`, e);
  }
  return results;
}

async function handleReviews(reviews, app) {  
  var appIsNew = await storeAppIfUnseen(app);
  // We skip if we don't have a lastSeenReviewId otherwise we'll flood the 
  // channel with historic reviews when a new app is added
  if(appIsNew) {
    console.log(`${app.cacheKey} is new, notifying slack of new watcher`);
    await postWatchingMessage(app);
  }

  if(reviews.length <= 0) {
    console.log('no reviews found for', app.cacheKey);
    return [];
  }

  var cachedReviews = [];
  for(var review, i = 0; review = reviews[i]; i++) {
    cachedReviews.push(storeReviewIfUnseen(app.cacheKey, review));
  }

  return Promise.all(cachedReviews).then((stored) => {
    var newReviews = stored.filter(item => item !== false);

    if(!appIsNew && newReviews.length > 0) {
      console.log('got new reviews for', app.cacheKey, newReviews);
      var handles = postReviewsToSlack(newReviews, app);
      return Promise.all(handles);
    }
    else {
      console.log('no new reviews for ' + app.cacheKey);
      return false;
    }
  });
}

async function storeAppIfUnseen(app) {
  try {
    var response = await DynamoDb.put({
      TableName: process.env.DYNAMODB_TABLE,
      Item: { 
        id: app.cacheKey,
        seen: (new Date()).toISOString()
      },
      ConditionExpression: "attribute_not_exists(id)"
    }).promise();

    console.log(response);

    return true;
  }
  catch(e) {
    if(e.name !== 'ConditionalCheckFailedException') {
      console.log(e);
      throw e;
    }
    return false;
  }
}

async function storeReviewIfUnseen(cacheKey, review) {
  try {
    var response = await DynamoDb.put({
      TableName: process.env.DYNAMODB_TABLE,
      Item: { 
        id: cacheKey + '-' + review.id,
        seen: (new Date()).toISOString(),
        text: review.text,
        score: review.score,
        url: review.url
      },
      ConditionExpression: "attribute_not_exists(id)"
    }).promise();

    return review;
  }
  catch(e) {
    if(e.name !== 'ConditionalCheckFailedException') {
      console.log(e);
      throw e;
    }
    return false;
  }
}

function postReviewsToSlack(reviews, app) {
  var handles = [];
  for(var review, i = 0; review = reviews[i]; i++) {
    var message = formatSlackMessage(review, app); 
    handles.push(postToSlack(message));
  }
  return handles;
}

function formatSlackMessage(review, app) {
  var stars = ''
  for (var i = 0; i < 5; i++) {
    stars += i < review.score ? '★' : '☆'
  }

  var pretext = 'New review'
  if (app.appName != null) {
    pretext += ' for ' + app.appName
  }
  if (app.store != null) {
    pretext += ' on ' + FRIENDLY_STORE_NAMES[app.store]
  }
  pretext += '!'

  var color = review.score >= 4 ? 'good' : (review.score >= 2 ? 'warning' : 'danger')

  var text = ''
  text += review.text + '\n'
  text += '_by ' + review.userName
  if (review.date) {
    text += ', ' + review.date
  }
  if (review.url) {
    text += ' - ' + '<' + review.url + '|' + FRIENDLY_STORE_NAMES[app.store] + '>'
  } else {
    text += ' - ' + FRIENDLY_STORE_NAMES[app.store]
  }
  text += '_'

  var message = {
    'attachments': [
      {
        'mrkdwn_in': ['text', 'pretext', 'title'],
        'fallback': pretext + ': ' + review.title + ' (' + stars + '): ' + review.text,
        'pretext': pretext,
        'color': color,
        'author_name': stars,
        'title': review.title,
        'title_link': review.url,
        'text': text
      }
    ]
  }

  return message;
}

async function postWatchingMessage(app) {
  var message = {
    'text': 'Now watching for reviews of ' + app.appName + ' on the ' + FRIENDLY_STORE_NAMES[app.store] + ' (`' + app.appId + '`)'
  }

  return await postToSlack(message);
}

async function postToSlack(message) {
  return Request.post({
    url: process.env.SLACK_HOOK_URL,
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(message)
  });
}

module.exports.handle = async () => {
  await start();
};
