# #serverless Review Monitor

Based on the [serverless framework](https://serverless.com) and leveraging the power of The Cloud™,
this wee function will periodically poll the Google Play Store the Apple App Store for new reviews
of the apps listed in `apps-google-play.json` and `apps-app-store.json`. These are then posted into
a Slack channel for maximium trendiness.

It stores the last received review ID for each app in each language/region in DynamoDB since
Lambda is stateless. By default it runs every 30 minutes.

It also uses AWS SSM Parameter Store for keeping the Slack Hook URL away from version control, since
technically anyone could use that to funnel messages into the slack org.

## Adding new apps to monitor

Add a new stanza to the `apps-google-play.json` or `apps-app-store.json` files depending on which 
store you want to look in. 

## Running locally

You'll need to install the `serverless` module from npm, which you can do with a

```bash
npm install -g serverless
```

If you are a PK person, you'll need to have the `pk-internal` AWS profile configured first. 

Then it should be as simple as:

```bash
AWS_PROFILE=pk-internal serverless invoke local --function app-reviews`
```

## Using this yourself

You'll probably want to edit the `serverless.yml` to use your own AWS account, and set up a
Slack Incoming Webhook and put it into Parameter Store and update accordingly.

Also you should probably update the `apps-google-play.json` and `apps-app-store.json` files 
with your own apps too.