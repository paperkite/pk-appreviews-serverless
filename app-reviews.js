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
  // for(var app, i = 0; app = APP_STORE_APPS[i]; i++) {
  //   await fetchFromAppStore(app);
  // }

  // for(var app, i = 0; app = PLAY_STORE_APPS[i]; i++) {
  //   await fetchFromGooglePlay(app);
  // }
  var appStore = APP_STORE_APPS.map(fetchFromAppStore);
  var playStore = PLAY_STORE_APPS.map(fetchFromGooglePlay);

  return Promise.all([].concat(playStore, appStore)).then(() => {
    console.log('done it all!');
  });
}

async function fetchFromAppStore(app) {
  var results = []
  for(var country, i = 0; country = app.countries[i]; i++) {
    console.log('Fetching reviews for: ', { id: app.appId, country: country });
    var reviews = await AppStore.reviews({ id: app.appId, country: country });
    app.store = 'app-store';
    app.cacheKey = [app.store, country, app.appId].join('-');
    results.push(await handleReviews(reviews, app));
  }
  return results;
}

async function fetchFromGooglePlay(app) {
  var results = []
  for(var language, i = 0; language = app.languages[i]; i++) {
    console.log('Fetching reviews for: ', { appId: app.appId, lang: language });
    var reviews = await PlayStore.reviews({ appId: app.appId, lang: language });
    app.store = 'google-play';
    app.cacheKey = [app.store, language, app.appId].join('-');
    return handleReviews(reviews, app);
  }
  return results;
}

async function handleReviews(reviews, app) {  
  var appData = await fetchAppData(app.cacheKey);

  // We skip if we don't have a lastSeenReviewId otherwise we'll flood the 
  // channel with historic reviews when a new app is added
  if(!appData.lastSeenReviewId) {
    console.log('no lastSeenReviewId, notifying slack of new watcher');
    await updateLastReviewSeen(app.cacheKey, reviews[0]);
    await postWatchingMessage(app);
    return [];
  }

  if(reviews.length <= 0) {
    console.log('no reviews found for ', app.cacheKey);
    return [];
  }

  var newReviews = [];
  for(var review, i = 0; review = reviews[i]; i++) {
    if(review.id == appData.lastSeenReviewId) { break }
    newReviews.push(review);
  }

  if(newReviews.length > 0) {
    console.log('got new reviews for', app.cacheKey, newReviews);
    await updateLastReviewSeen(app.cacheKey, newReviews[0]);
    await postReviewsToSlack(newReviews, app);

    return newReviews;
  }
  else {
    console.log('no new reviews for ' + app.cacheKey);
    return [];
  }
}

async function fetchAppData(cacheKey) {
  // fetch todo from the database
  console.log(process.env.DYNAMODB_TABLE);
  var app = {};
  try {
    var response = await DynamoDb.get({
      TableName: process.env.DYNAMODB_TABLE,
      Key: { id: cacheKey },
    }).promise();

    app = response.Item || {};
  }
  catch(e) {
    console.log(e);
    if(e.name !== 'ResourceNotFoundException') {
      throw e;
    }
  }

  return app;
}


async function updateLastReviewSeen(cacheKey, review) {
  var id = review ? review.id : 'undefined';
  console.log('setting last review id for ' + cacheKey + ' to ' + id);
  console.log(process.env.DYNAMODB_TABLE);
  try {
    var response = await DynamoDb.put({
      TableName: process.env.DYNAMODB_TABLE,
      Item: { 
        id: cacheKey,
        lastSeenReviewId: id
      },
    }).promise();  
  }
  catch(e) {
    console.log(e);
    throw e;
  }

  return response;
}

async function postReviewsToSlack(reviews, app) {
  for(var review, i = 0; review = reviews[i]; i++) {
    var message = formatSlackMessage(review, app); 
    await postToSlack(message);
  }
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
